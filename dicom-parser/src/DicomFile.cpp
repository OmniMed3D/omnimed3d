#include "dicom-parser/DicomFile.hpp"

#include <cstring>

namespace dicom_parser {

namespace {

constexpr size_t kPreambleSize = 128;
constexpr char kMagic[4] = {'D', 'I', 'C', 'M'};

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
    // DICOM UI values are padded to an even length with a trailing NUL.
    while (!s.empty() && (s.back() == '\0' || s.back() == ' ')) {
        s.pop_back();
    }
    return s;
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

    // First element must be (0002,0000) UL FileMetaInformationGroupLength --
    // its value is the byte length of everything else in group 0002.
    if (offset + 8 > size) {
        return fail(DicomParseError::Truncated);
    }
    uint16_t const firstGroup = readU16LE(data + offset);
    uint16_t const firstElement = readU16LE(data + offset + 2);
    if (firstGroup != 0x0002 || firstElement != 0x0000) {
        return fail(DicomParseError::MissingGroupLength);
    }
    uint16_t const groupLengthValueLen = readU16LE(data + offset + 6);
    if (offset + 8 + groupLengthValueLen > size) {
        return fail(DicomParseError::Truncated);
    }
    info.metaGroupLength = readU32LE(data + offset + 8);
    offset += 8 + groupLengthValueLen;

    size_t const groupEnd = offset + info.metaGroupLength;
    if (groupEnd > size) {
        return fail(DicomParseError::Truncated);
    }

    while (offset < groupEnd) {
        if (offset + 8 > size) {
            return fail(DicomParseError::Truncated);
        }
        uint16_t const group = readU16LE(data + offset);
        uint16_t const element = readU16LE(data + offset + 2);
        char const vr[2] = {static_cast<char>(data[offset + 4]), static_cast<char>(data[offset + 5])};

        size_t valueOffset;
        uint32_t valueLength;
        if (vrHasLongLength(vr)) {
            if (offset + 12 > size) {
                return fail(DicomParseError::Truncated);
            }
            valueLength = readU32LE(data + offset + 8);
            valueOffset = offset + 12;
        } else {
            valueLength = readU16LE(data + offset + 6);
            valueOffset = offset + 8;
        }
        if (valueOffset + valueLength > size) {
            return fail(DicomParseError::Truncated);
        }

        if (group == 0x0002) {
            std::string const value(reinterpret_cast<char const*>(data + valueOffset), valueLength);
            if (element == 0x0002) {
                info.mediaStorageSOPClassUID = trimPadding(value);
            } else if (element == 0x0003) {
                info.mediaStorageSOPInstanceUID = trimPadding(value);
            } else if (element == 0x0010) {
                info.transferSyntaxUID = trimPadding(value);
            }
        }

        offset = valueOffset + valueLength;
    }

    return info;
}

}  // namespace dicom_parser
