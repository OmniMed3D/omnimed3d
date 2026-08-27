#include "dicom-parser/DicomFile.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace dicom_parser {

namespace {

constexpr size_t kPreambleSize = 128;
constexpr char kMagic[4] = {'D', 'I', 'C', 'M'};

constexpr char const* kExplicitVRLittleEndian = "1.2.840.10008.1.2.1";
constexpr char const* kImplicitVRLittleEndian = "1.2.840.10008.1.2";

uint16_t readU16LE(std::byte const* p) {
    return static_cast<uint16_t>(static_cast<uint8_t>(p[0])) |
           static_cast<uint16_t>(static_cast<uint8_t>(p[1]) << 8);
}

uint32_t readU32LE(std::byte const* p) {
    return static_cast<uint32_t>(static_cast<uint8_t>(p[0])) |
           (static_cast<uint32_t>(static_cast<uint8_t>(p[1])) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(p[2])) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(p[3])) << 24);
}

// Explicit-VR long form (2 reserved bytes + 4-byte length) vs. short form
// (2-byte length) -- group 0002 is always Explicit VR Little Endian
// regardless of the dataset's own transfer syntax (DICOM PS3.10).
bool vrHasLongLength(char const vr[2]) {
    static constexpr char const* kLongForms[] = {"OB", "OW", "OF", "SQ", "UT", "UN"};
    for (auto const* form : kLongForms) {
        if (vr[0] == form[0] && vr[1] == form[1]) {
            return true;
        }
    }
    return false;
}

std::string trimPadding(std::string s) {
    // DICOM UI/CS values are padded to an even length with a trailing NUL
    // or space.
    while (!s.empty() && (s.back() == '\0' || s.back() == ' ')) {
        s.pop_back();
    }
    return s;
}

std::string trimWhitespace(std::string s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\0')) {
        s.erase(s.begin());
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\0')) {
        s.pop_back();
    }
    return s;
}

// IS (Integer String) -- same even-length whitespace/NUL padding
// convention as DS, but always single-valued for the tags this parser
// cares about (InstanceNumber), so no backslash-splitting is needed here.
int32_t parseISValue(std::string const& raw) {
    std::string const trimmed = trimWhitespace(raw);
    if (trimmed.empty()) {
        return 0;
    }
    return static_cast<int32_t>(std::strtol(trimmed.c_str(), nullptr, 10));
}

// DS (Decimal String) values are backslash-separated for multi-valued
// fields (e.g. PixelSpacing = "row\column").
std::vector<double> parseDSValues(std::string const& raw) {
    std::vector<double> values;
    size_t start = 0;
    while (start <= raw.size()) {
        size_t const sep = raw.find('\\', start);
        std::string token =
            trimWhitespace(raw.substr(start, sep == std::string::npos ? std::string::npos : sep - start));
        if (!token.empty()) {
            values.push_back(std::strtod(token.c_str(), nullptr));
        }
        if (sep == std::string::npos) {
            break;
        }
        start = sep + 1;
    }
    return values;
}

struct ExplicitElementHeader {
    uint16_t group;
    uint16_t element;
    size_t valueOffset;
    uint32_t valueLength;
};

// Reads one Explicit-VR element header (group + element + VR + length) at
// `offset`. Returns std::nullopt if truncated. Shared between parseFromBuffer
// (group 0002) and parseImageInfo's Explicit-VR main-dataset walker -- same
// short/long length-form rule applies to both.
std::optional<ExplicitElementHeader> readExplicitElementHeader(std::byte const* data, size_t offset, size_t size) {
    if (offset + 8 > size) {
        return std::nullopt;
    }
    uint16_t const group = readU16LE(data + offset);
    uint16_t const element = readU16LE(data + offset + 2);
    char const vr[2] = {static_cast<char>(data[offset + 4]), static_cast<char>(data[offset + 5])};

    size_t valueOffset;
    uint32_t valueLength;
    if (vrHasLongLength(vr)) {
        if (offset + 12 > size) {
            return std::nullopt;
        }
        valueLength = readU32LE(data + offset + 8);
        valueOffset = offset + 12;
    } else {
        valueLength = readU16LE(data + offset + 6);
        valueOffset = offset + 8;
    }
    return ExplicitElementHeader{group, element, valueOffset, valueLength};
}

struct ImplicitElementHeader {
    uint16_t group;
    uint16_t element;
    size_t valueOffset;
    uint32_t valueLength;
};

// Implicit VR has no VR bytes in the stream at all -- every element is
// uniformly tag(4 bytes) + length(4 bytes) + value, so (unlike Explicit VR)
// no short/long-form branching is needed just to walk past an element.
std::optional<ImplicitElementHeader> readImplicitElementHeader(std::byte const* data, size_t offset, size_t size) {
    if (offset + 8 > size) {
        return std::nullopt;
    }
    uint16_t const group = readU16LE(data + offset);
    uint16_t const element = readU16LE(data + offset + 2);
    uint32_t const valueLength = readU32LE(data + offset + 4);
    return ImplicitElementHeader{group, element, offset + 8, valueLength};
}

// FFFE is reserved for Item / Item Delimitation Item / Sequence
// Delimitation Item (DICOM PS3.5 7.5) -- these never carry VR bytes or a
// short/long length-form distinction, regardless of whether the enclosing
// dataset is Explicit or Implicit VR. A dataset walker that blindly
// applied Explicit-VR header rules inside a sequence's Items would
// misread a delimiter's tag+length as VR+length instead.
constexpr uint16_t kDelimiterGroup = 0xFFFE;
constexpr uint16_t kItemTag = 0xE000;
constexpr uint16_t kItemDelimitationTag = 0xE00D;
constexpr uint16_t kSequenceDelimitationTag = 0xE0DD;

struct ElementHeader {
    uint16_t group;
    uint16_t element;
    size_t valueOffset;
    uint32_t valueLength;
};

// Reads one element header at `offset`, dispatching to the delimiter shape
// (group 0xFFFE) or the dataset's own Explicit/Implicit VR shape. Shared by
// the top-level dataset walk and the undefined-length sequence/item skip
// below, since both can encounter delimiters (skip) or ordinary elements
// (walk).
std::optional<ElementHeader> readElementHeader(std::byte const* data, size_t offset, size_t size, bool explicitVR) {
    if (offset + 4 > size) {
        return std::nullopt;
    }
    if (readU16LE(data + offset) == kDelimiterGroup) {
        auto const header = readImplicitElementHeader(data, offset, size);
        if (!header) {
            return std::nullopt;
        }
        return ElementHeader{header->group, header->element, header->valueOffset, header->valueLength};
    }
    if (explicitVR) {
        auto const header = readExplicitElementHeader(data, offset, size);
        if (!header) {
            return std::nullopt;
        }
        return ElementHeader{header->group, header->element, header->valueOffset, header->valueLength};
    }
    auto const header = readImplicitElementHeader(data, offset, size);
    if (!header) {
        return std::nullopt;
    }
    return ElementHeader{header->group, header->element, header->valueOffset, header->valueLength};
}

std::optional<size_t> skipUndefinedLengthSequence(std::byte const* data, size_t offset, size_t size, bool explicitVR);

// Skips one Item's own dataset (only needed when the Item itself has
// undefined length -- a defined-length Item is skipped by byte count
// alone, see the caller). Walks nested elements using the enclosing
// dataset's Explicit/Implicit VR rules until the Item Delimitation Item,
// recursing for any nested undefined-length sequence found along the way
// (sequences nest arbitrarily per DICOM PS3.5 7.5).
std::optional<size_t> skipItemDataset(std::byte const* data, size_t offset, size_t size, bool explicitVR) {
    while (true) {
        auto const header = readElementHeader(data, offset, size, explicitVR);
        if (!header) {
            return std::nullopt;
        }
        if (header->group == kDelimiterGroup && header->element == kItemDelimitationTag) {
            return header->valueOffset;
        }
        if (header->valueLength == 0xFFFFFFFFu) {
            auto const after = skipUndefinedLengthSequence(data, header->valueOffset, size, explicitVR);
            if (!after) {
                return std::nullopt;
            }
            offset = *after;
            continue;
        }
        if (header->valueOffset + header->valueLength > size) {
            return std::nullopt;
        }
        offset = header->valueOffset + header->valueLength;
    }
}

// Skips an undefined-length SQ element's Items, starting right after the
// SQ element's own header (i.e. `offset` == that header's valueOffset),
// up to and including its Sequence Delimitation Item. Only skips -- this
// parser has no caller that needs sequence contents, so there is no value
// in decoding Items beyond what's needed to find their end.
std::optional<size_t> skipUndefinedLengthSequence(std::byte const* data, size_t offset, size_t size,
                                                    bool explicitVR) {
    while (true) {
        auto const header = readElementHeader(data, offset, size, explicitVR);
        if (!header || header->group != kDelimiterGroup) {
            // A well-formed sequence contains only Items and ends with a
            // Sequence Delimitation Item -- anything else means the buffer
            // doesn't actually match the structure this function assumes.
            return std::nullopt;
        }
        if (header->element == kSequenceDelimitationTag) {
            return header->valueOffset;
        }
        if (header->element != kItemTag) {
            return std::nullopt;
        }
        if (header->valueLength == 0xFFFFFFFFu) {
            auto const after = skipItemDataset(data, header->valueOffset, size, explicitVR);
            if (!after) {
                return std::nullopt;
            }
            offset = *after;
            continue;
        }
        if (header->valueOffset + header->valueLength > size) {
            return std::nullopt;
        }
        offset = header->valueOffset + header->valueLength;
    }
}

// Tags parseImageInfo cares about. For Implicit VR this list also doubles as
// the "how do I interpret this value" table, since Implicit VR doesn't carry
// VR information in the stream itself -- everything else is skipped by
// length without needing to know its VR.
enum class KnownTag {
    SamplesPerPixel,
    PhotometricInterpretation,
    Rows,
    Columns,
    PixelSpacing,
    SliceThickness,
    BitsAllocated,
    BitsStored,
    PixelRepresentation,
    RescaleIntercept,
    RescaleSlope,
    PixelData,
    InstanceNumber,
    ImageOrientationPatient,
    ImagePositionPatient,
    WindowCenter,
    WindowWidth,
    Modality,
};

struct TagLookup {
    uint16_t group;
    uint16_t element;
    KnownTag tag;
};

constexpr TagLookup kKnownTags[] = {
    {0x0028, 0x0002, KnownTag::SamplesPerPixel},
    {0x0028, 0x0004, KnownTag::PhotometricInterpretation},
    {0x0028, 0x0010, KnownTag::Rows},
    {0x0028, 0x0011, KnownTag::Columns},
    {0x0028, 0x0030, KnownTag::PixelSpacing},
    {0x0018, 0x0050, KnownTag::SliceThickness},
    {0x0028, 0x0100, KnownTag::BitsAllocated},
    {0x0028, 0x0101, KnownTag::BitsStored},
    {0x0028, 0x0103, KnownTag::PixelRepresentation},
    {0x0028, 0x1052, KnownTag::RescaleIntercept},
    {0x0028, 0x1053, KnownTag::RescaleSlope},
    {0x7FE0, 0x0010, KnownTag::PixelData},
    {0x0020, 0x0013, KnownTag::InstanceNumber},
    {0x0020, 0x0037, KnownTag::ImageOrientationPatient},
    {0x0020, 0x0032, KnownTag::ImagePositionPatient},
    {0x0028, 0x1050, KnownTag::WindowCenter},
    {0x0028, 0x1051, KnownTag::WindowWidth},
    {0x0008, 0x0060, KnownTag::Modality},
};

std::optional<KnownTag> lookupKnownTag(uint16_t group, uint16_t element) {
    for (auto const& entry : kKnownTags) {
        if (entry.group == group && entry.element == element) {
            return entry.tag;
        }
    }
    return std::nullopt;
}

// Tracks which required fields (needed to interpret PixelData at all) were
// actually found during the dataset walk.
struct RequiredFieldsFound {
    bool rows = false;
    bool columns = false;
    bool bitsAllocated = false;
    bool pixelRepresentation = false;
    bool pixelData = false;
};

void applyKnownTagValue(KnownTag tag, std::byte const* data, size_t valueOffset, uint32_t valueLength,
                         DicomImageInfo& info, RequiredFieldsFound& found) {
    switch (tag) {
        case KnownTag::SamplesPerPixel:
            if (valueLength >= 2) {
                info.samplesPerPixel = readU16LE(data + valueOffset);
            }
            break;
        case KnownTag::PhotometricInterpretation:
            info.photometricInterpretation =
                trimPadding(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            break;
        case KnownTag::Rows:
            if (valueLength >= 2) {
                info.rows = readU16LE(data + valueOffset);
                found.rows = true;
            }
            break;
        case KnownTag::Columns:
            if (valueLength >= 2) {
                info.columns = readU16LE(data + valueOffset);
                found.columns = true;
            }
            break;
        case KnownTag::PixelSpacing: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (values.size() >= 2) {
                info.pixelSpacingRow = values[0];
                info.pixelSpacingColumn = values[1];
            }
            break;
        }
        case KnownTag::SliceThickness: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (!values.empty()) {
                info.sliceThickness = values[0];
            }
            break;
        }
        case KnownTag::BitsAllocated:
            if (valueLength >= 2) {
                info.bitsAllocated = readU16LE(data + valueOffset);
                found.bitsAllocated = true;
            }
            break;
        case KnownTag::BitsStored:
            if (valueLength >= 2) {
                info.bitsStored = readU16LE(data + valueOffset);
            }
            break;
        case KnownTag::PixelRepresentation:
            if (valueLength >= 2) {
                info.pixelRepresentation = readU16LE(data + valueOffset);
                found.pixelRepresentation = true;
            }
            break;
        case KnownTag::RescaleIntercept: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (!values.empty()) {
                info.rescaleIntercept = values[0];
            }
            break;
        }
        case KnownTag::RescaleSlope: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (!values.empty()) {
                info.rescaleSlope = values[0];
            }
            break;
        }
        case KnownTag::PixelData:
            info.pixelData = data + valueOffset;
            info.pixelDataLength = valueLength;
            found.pixelData = true;
            break;
        case KnownTag::InstanceNumber:
            info.instanceNumber =
                parseISValue(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            break;
        case KnownTag::ImageOrientationPatient: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (values.size() == 6) {
                std::copy(values.begin(), values.end(), info.imageOrientationPatient);
                info.hasImageOrientationPatient = true;
            }
            break;
        }
        case KnownTag::ImagePositionPatient: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (values.size() == 3) {
                std::copy(values.begin(), values.end(), info.imagePositionPatient);
                info.hasImagePositionPatient = true;
            }
            break;
        }
        case KnownTag::WindowCenter: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (!values.empty()) {
                info.windowCenter = values[0];
                info.hasWindowCenter = true;
            }
            break;
        }
        case KnownTag::WindowWidth: {
            auto const values =
                parseDSValues(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            if (!values.empty()) {
                info.windowWidth = values[0];
                info.hasWindowWidth = true;
            }
            break;
        }
        case KnownTag::Modality:
            info.modality =
                trimPadding(std::string(reinterpret_cast<char const*>(data + valueOffset), valueLength));
            break;
    }
}

}  // namespace

std::optional<DicomMetaInfo> DicomFile::parseFromBuffer(std::byte const* data, size_t size,
                                                          DicomParseError* outError) {
    auto fail = [&](DicomParseError e) -> std::optional<DicomMetaInfo> {
        if (outError) {
            *outError = e;
        }
        return std::nullopt;
    };

    if (size < kPreambleSize + 4) {
        return fail(DicomParseError::BufferTooSmall);
    }
    if (std::memcmp(data + kPreambleSize, kMagic, 4) != 0) {
        return fail(DicomParseError::MissingMagic);
    }

    size_t offset = kPreambleSize + 4;
    DicomMetaInfo info;

    // First element should be (0002,0000) UL FileMetaInformationGroupLength
    // -- its value is the byte length of everything else in group 0002.
    // Some real-world files (seen in TCIA MR series) omit this element
    // entirely and go straight to (0002,0010) TransferSyntaxUID, even
    // though DICOM PS3.10 nominally requires it. Rather than reject those
    // files, fall back to scanning group 0002 element-by-element until the
    // group number changes, the way most real DICOM readers tolerate it.
    if (offset + 8 > size) {
        return fail(DicomParseError::Truncated);
    }
    uint16_t const firstGroup = readU16LE(data + offset);
    uint16_t const firstElement = readU16LE(data + offset + 2);
    if (firstGroup != 0x0002) {
        return fail(DicomParseError::MissingGroupLength);
    }

    bool hasExplicitGroupEnd = false;
    size_t groupEnd = size;
    if (firstElement == 0x0000) {
        uint16_t const groupLengthValueLen = readU16LE(data + offset + 6);
        if (offset + 8 + groupLengthValueLen > size) {
            return fail(DicomParseError::Truncated);
        }
        info.metaGroupLength = readU32LE(data + offset + 8);
        offset += 8 + groupLengthValueLen;
        groupEnd = offset + info.metaGroupLength;
        if (groupEnd > size) {
            return fail(DicomParseError::Truncated);
        }
        hasExplicitGroupEnd = true;
    }

    while (offset < groupEnd) {
        auto const header = readExplicitElementHeader(data, offset, size);
        if (!header) {
            return fail(DicomParseError::Truncated);
        }
        if (!hasExplicitGroupEnd && header->group != 0x0002) {
            break;
        }
        if (header->valueOffset + header->valueLength > size) {
            return fail(DicomParseError::Truncated);
        }

        if (header->group == 0x0002) {
            std::string const value(reinterpret_cast<char const*>(data + header->valueOffset), header->valueLength);
            if (header->element == 0x0002) {
                info.mediaStorageSOPClassUID = trimPadding(value);
            } else if (header->element == 0x0003) {
                info.mediaStorageSOPInstanceUID = trimPadding(value);
            } else if (header->element == 0x0010) {
                info.transferSyntaxUID = trimPadding(value);
            }
        }

        offset = header->valueOffset + header->valueLength;
    }

    info.dataSetOffset = offset;
    return info;
}

std::optional<DicomImageInfo> DicomFile::parseImageInfo(std::byte const* data, size_t size, size_t dataSetOffset,
                                                          std::string const& transferSyntaxUID,
                                                          DicomParseError* outError) {
    auto fail = [&](DicomParseError e) -> std::optional<DicomImageInfo> {
        if (outError) {
            *outError = e;
        }
        return std::nullopt;
    };

    bool const explicitVR = (transferSyntaxUID == kExplicitVRLittleEndian);
    bool const implicitVR = (transferSyntaxUID == kImplicitVRLittleEndian);
    if (!explicitVR && !implicitVR) {
        return fail(DicomParseError::UnsupportedTransferSyntax);
    }

    DicomImageInfo info;
    RequiredFieldsFound found;

    size_t offset = dataSetOffset;
    while (offset + 8 <= size) {
        uint16_t group;
        uint16_t element;
        size_t valueOffset;
        uint32_t valueLength;

        if (explicitVR) {
            auto const header = readExplicitElementHeader(data, offset, size);
            if (!header) {
                return fail(DicomParseError::Truncated);
            }
            group = header->group;
            element = header->element;
            valueOffset = header->valueOffset;
            valueLength = header->valueLength;
        } else {
            auto const header = readImplicitElementHeader(data, offset, size);
            if (!header) {
                return fail(DicomParseError::Truncated);
            }
            group = header->group;
            element = header->element;
            valueOffset = header->valueOffset;
            valueLength = header->valueLength;
        }

        // Undefined length -- an SQ element (common even in otherwise-
        // uncompressed CT/MR studies, e.g. "Referenced Image Sequence") or,
        // in principle, encapsulated/compressed PixelData. The latter can't
        // actually occur here: a compressed transfer syntax was already
        // rejected above via UnsupportedTransferSyntax, so by this point
        // 0xFFFFFFFF always means a sequence. None of kKnownTags is ever
        // SQ-valued, so this parser only needs to skip past it to keep
        // walking the rest of the dataset (see docs/adr/0002's "revisit
        // this decision" trigger). A malformed/truncated sequence still
        // fails loudly via UnsupportedSequenceEncoding rather than
        // misparsing.
        if (valueLength == 0xFFFFFFFFu) {
            auto const after = skipUndefinedLengthSequence(data, valueOffset, size, explicitVR);
            if (!after) {
                return fail(DicomParseError::UnsupportedSequenceEncoding);
            }
            offset = *after;
            continue;
        }
        if (valueOffset + valueLength > size) {
            return fail(DicomParseError::Truncated);
        }

        if (auto const knownTag = lookupKnownTag(group, element)) {
            applyKnownTagValue(*knownTag, data, valueOffset, valueLength, info, found);
        }

        offset = valueOffset + valueLength;
    }

    if (!found.rows || !found.columns || !found.bitsAllocated || !found.pixelRepresentation || !found.pixelData) {
        return fail(DicomParseError::MissingRequiredElement);
    }
    if (info.samplesPerPixel != 1 || (info.photometricInterpretation != "MONOCHROME1" &&
                                       info.photometricInterpretation != "MONOCHROME2")) {
        return fail(DicomParseError::UnsupportedPixelFormat);
    }

    return info;
}

}  // namespace dicom_parser
