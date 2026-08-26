// Native-only automated regression test for the shared DICOM parser --
// hand-rolled assertions (no GoogleTest/Catch2 dependency, per CLAUDE.md
// #4's "no new dependencies without explicit consent") wired into CTest,
// which ships with CMake so this needs nothing beyond what already must
// build cross-platform (including macOS) for the project itself.
//
// Ground-truth values below were hand-derived from CT_small.dcm's actual
// bytes (dumped directly, not assumed) while designing parseImageInfo --
// see docs/adr/0002-dicom-parser-uncompressed-pixel-data.md.

#include "dicom-parser/DicomFile.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

void check(bool condition, char const* description) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", description);
        ++g_failures;
    }
}

void checkEq(std::string const& actual, std::string const& expected, char const* field) {
    if (actual != expected) {
        std::fprintf(stderr, "FAIL: %s -- expected '%s', got '%s'\n", field, expected.c_str(), actual.c_str());
        ++g_failures;
    }
}

void checkEqU(unsigned long long actual, unsigned long long expected, char const* field) {
    if (actual != expected) {
        std::fprintf(stderr, "FAIL: %s -- expected %llu, got %llu\n", field, expected, actual);
        ++g_failures;
    }
}

void checkNear(double actual, double expected, double epsilon, char const* field) {
    if (std::abs(actual - expected) > epsilon) {
        std::fprintf(stderr, "FAIL: %s -- expected %g, got %g\n", field, expected, actual);
        ++g_failures;
    }
}

std::vector<std::byte> readFile(char const* path) {
    std::ifstream file(path, std::ios::binary);
    std::vector<char> const raw((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    std::vector<std::byte> bytes(raw.size());
    for (size_t i = 0; i < raw.size(); ++i) {
        bytes[i] = static_cast<std::byte>(raw[i]);
    }
    return bytes;
}

void testCtSmallHappyPath() {
    auto const bytes = readFile(CT_SMALL_DCM_PATH);
    check(!bytes.empty(), "CT_small.dcm fixture loaded (non-empty)");
    if (bytes.empty()) {
        return;
    }

    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(bytes.data(), bytes.size(), &error);
    check(meta.has_value(), "parseFromBuffer succeeds on CT_small.dcm");
    if (!meta) {
        return;
    }

    checkEqU(meta->metaGroupLength, 192, "metaGroupLength");
    checkEq(meta->mediaStorageSOPClassUID, "1.2.840.10008.5.1.4.1.1.2", "mediaStorageSOPClassUID");
    checkEq(meta->mediaStorageSOPInstanceUID, "1.3.6.1.4.1.5962.1.1.1.1.1.20040119072730.12322",
            "mediaStorageSOPInstanceUID");
    checkEq(meta->transferSyntaxUID, "1.2.840.10008.1.2.1", "transferSyntaxUID");
    checkEqU(meta->dataSetOffset, 336, "dataSetOffset");

    auto const image = dicom_parser::DicomFile::parseImageInfo(bytes.data(), bytes.size(), meta->dataSetOffset,
                                                                 meta->transferSyntaxUID, &error);
    check(image.has_value(), "parseImageInfo succeeds on CT_small.dcm");
    if (!image) {
        return;
    }

    checkEqU(image->rows, 128, "rows");
    checkEqU(image->columns, 128, "columns");
    checkEqU(image->bitsAllocated, 16, "bitsAllocated");
    checkEqU(image->bitsStored, 16, "bitsStored");
    checkEqU(image->pixelRepresentation, 1, "pixelRepresentation (signed)");
    checkEqU(image->samplesPerPixel, 1, "samplesPerPixel");
    checkEq(image->photometricInterpretation, "MONOCHROME2", "photometricInterpretation");
    checkNear(image->pixelSpacingRow, 0.661468, 1e-6, "pixelSpacingRow");
    checkNear(image->pixelSpacingColumn, 0.661468, 1e-6, "pixelSpacingColumn");
    checkNear(image->sliceThickness, 5.0, 1e-9, "sliceThickness");
    checkNear(image->rescaleSlope, 1.0, 1e-9, "rescaleSlope");
    checkNear(image->rescaleIntercept, -1024.0, 1e-9, "rescaleIntercept");
    checkEqU(image->pixelDataLength, 32768, "pixelDataLength");
    check(image->pixelData != nullptr, "pixelData pointer is non-null");
    check(image->instanceNumber == 1, "instanceNumber");

    check(image->hasImageOrientationPatient, "hasImageOrientationPatient");
    checkNear(image->imageOrientationPatient[0], 1.0, 1e-6, "imageOrientationPatient[0]");
    checkNear(image->imageOrientationPatient[1], 0.0, 1e-6, "imageOrientationPatient[1]");
    checkNear(image->imageOrientationPatient[2], 0.0, 1e-6, "imageOrientationPatient[2]");
    checkNear(image->imageOrientationPatient[3], 0.0, 1e-6, "imageOrientationPatient[3]");
    checkNear(image->imageOrientationPatient[4], 1.0, 1e-6, "imageOrientationPatient[4]");
    checkNear(image->imageOrientationPatient[5], 0.0, 1e-6, "imageOrientationPatient[5]");

    check(!image->hasWindowCenter, "CT_small.dcm has no WindowCenter tag (ground truth: not present in the real bytes)");
    check(!image->hasWindowWidth, "CT_small.dcm has no WindowWidth tag (ground truth: not present in the real bytes)");

    check(image->hasImagePositionPatient, "hasImagePositionPatient");
    checkNear(image->imagePositionPatient[0], -158.135803, 1e-4, "imagePositionPatient[0]");
    checkNear(image->imagePositionPatient[1], -179.035797, 1e-4, "imagePositionPatient[1]");
    checkNear(image->imagePositionPatient[2], -75.699997, 1e-4, "imagePositionPatient[2]");
}

void testBufferTooSmall() {
    std::vector<std::byte> const tiny(10);
    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(tiny.data(), tiny.size(), &error);
    check(!meta.has_value(), "parseFromBuffer rejects an undersized buffer");
    check(error == dicom_parser::DicomParseError::BufferTooSmall, "undersized buffer reports BufferTooSmall");
}

void testMissingMagic() {
    // Preamble + 4 bytes, all zero -- not the "DICM" magic.
    std::vector<std::byte> const buffer(132, std::byte{0});
    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(buffer.data(), buffer.size(), &error);
    check(!meta.has_value(), "parseFromBuffer rejects a buffer without the DICM magic");
    check(error == dicom_parser::DicomParseError::MissingMagic, "missing magic reports MissingMagic");
}

// Bug fix, 2026-08-27 (user report: TCIA's TCGA-GBM MR series failed to
// load entirely, while the LIDC-IDRI CT series in the same test folder
// loaded fine). Hand-built rather than a checked-in fixture file -- this
// is deliberately the minimal buffer that reproduces the bug: a File Meta
// group with no (0002,0000) group-length element at all, just a single
// (0002,0010) TransferSyntaxUID, exactly matching what a real hex dump of
// the TCGA-GBM files showed (see DicomFile.cpp's own comment on this
// fallback). Preamble is left all-zero -- parseFromBuffer never reads it
// beyond checking size, only the "DICM" magic right after it matters.
std::vector<std::byte> buildMissingGroupLengthBuffer() {
    std::vector<uint8_t> bytes(128, 0);  // preamble
    auto const appendStr = [&](char const* s) {
        for (char const* p = s; *p != '\0'; ++p) {
            bytes.push_back(static_cast<uint8_t>(*p));
        }
    };
    auto const appendU16LE = [&](uint16_t v) {
        bytes.push_back(static_cast<uint8_t>(v & 0xFF));
        bytes.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    };

    appendStr("DICM");

    // (0002,0010) UI TransferSyntaxUID = "1.2.840.10008.1.2" (Implicit VR
    // Little Endian), NUL-padded to an even length (18 bytes) per the UI
    // VR's own padding rule.
    appendU16LE(0x0002);
    appendU16LE(0x0010);
    appendStr("UI");
    appendU16LE(18);
    appendStr("1.2.840.10008.1.2");
    bytes.push_back(0);  // pad to even length

    // First main-dataset element (0008,0005) SpecificCharacterSet, VR=CS,
    // zero-length -- only its header needs to be valid; parseFromBuffer
    // breaks as soon as it sees a non-0002 group, before touching a value.
    appendU16LE(0x0008);
    appendU16LE(0x0005);
    appendStr("CS");
    appendU16LE(0);

    std::vector<std::byte> result(bytes.size());
    for (size_t i = 0; i < bytes.size(); ++i) {
        result[i] = static_cast<std::byte>(bytes[i]);
    }
    return result;
}

void testMissingGroupLengthFallback() {
    auto const buffer = buildMissingGroupLengthBuffer();
    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(buffer.data(), buffer.size(), &error);
    check(meta.has_value(), "parseFromBuffer tolerates a File Meta group with no (0002,0000) group-length element");
    if (!meta) {
        return;
    }
    checkEq(meta->transferSyntaxUID, "1.2.840.10008.1.2", "transferSyntaxUID (fallback scan)");
    checkEq(meta->mediaStorageSOPClassUID, "", "mediaStorageSOPClassUID absent, left empty (fallback scan)");
    // 132 (preamble+DICM) + 26 (the one TransferSyntaxUID element) -- see
    // buildMissingGroupLengthBuffer()'s own comment for the byte layout.
    checkEqU(meta->dataSetOffset, 158, "dataSetOffset (fallback scan stops at the first non-0002 group)");
}

// Bug fix, 2026-08-27 (user report: UPENN-GBM MR series under
// omnimed3d_tests/Brain failed to load -- every sampled file hit
// UnsupportedSequenceEncoding via dicom_inspect, confirmed to be an
// undefined-length SQ element, e.g. Referenced Image Sequence, appearing
// before Rows/Columns/PixelData). Hand-built minimal Implicit VR buffer
// containing one undefined-length sequence with one undefined-length Item
// nested inside it, exactly the structure docs/adr/0002 called out as the
// scope gap to revisit "if a genuine need ... surfaces". Also carries a
// WindowCenter/WindowWidth pair (same follow-up bug report: the app
// rendered this dataset as a blown-out white block under a CT-calibrated
// preset -- MR pixel values aren't Hounsfield Units, so the file's own
// VOI LUT window is the only reliable display hint) so one fixture
// exercises both fixes together.
std::vector<std::byte> buildUndefinedLengthSequenceBuffer() {
    std::vector<uint8_t> bytes(128, 0);  // preamble
    auto const appendStr = [&](char const* s) {
        for (char const* p = s; *p != '\0'; ++p) {
            bytes.push_back(static_cast<uint8_t>(*p));
        }
    };
    auto const appendU16LE = [&](uint16_t v) {
        bytes.push_back(static_cast<uint8_t>(v & 0xFF));
        bytes.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    };
    auto const appendU32LE = [&](uint32_t v) {
        bytes.push_back(static_cast<uint8_t>(v & 0xFF));
        bytes.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
        bytes.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
        bytes.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
    };
    // Implicit VR element: tag(4) + length(4) + value, no VR bytes at all.
    auto const appendImplicitElement = [&](uint16_t group, uint16_t element, uint32_t length) {
        appendU16LE(group);
        appendU16LE(element);
        appendU32LE(length);
    };

    appendStr("DICM");

    // File Meta group (always Explicit VR Little Endian regardless of the
    // dataset's own transfer syntax) -- group length covers just the one
    // TransferSyntaxUID element that follows it (8-byte header + 18-byte
    // value = 26).
    appendU16LE(0x0002);
    appendU16LE(0x0000);
    appendStr("UL");
    appendU16LE(4);
    appendU32LE(26);
    appendU16LE(0x0002);
    appendU16LE(0x0010);
    appendStr("UI");
    appendU16LE(18);
    appendStr("1.2.840.10008.1.2");  // Implicit VR Little Endian, 17 chars
    bytes.push_back(0);              // pad to even length (18)

    // Modality (CS) -- "MR", matching the real UPENN-GBM series this
    // fixture models. Exercises the same auto-select-vs-CT-preset fix this
    // WindowCenter/WindowWidth pair does (bug report, 2026-08-27: a plain
    // "has a VOI LUT window" check wrongly caught real CT series too, which
    // also commonly carry one -- Modality is the actual signal callers need).
    appendImplicitElement(0x0008, 0x0060, 2);  // Modality = "MR"
    appendStr("MR");

    // Main dataset, Implicit VR:
    // (0008,1140) ReferencedImageSequence, undefined length --
    //   Item (FFFE,E000), undefined length --
    //     (0008,1150) ReferencedSOPClassUID = "1.2\0" (4 bytes)
    //   Item Delimitation Item (FFFE,E00D), length 0
    // Sequence Delimitation Item (FFFE,E0DD), length 0
    appendImplicitElement(0x0008, 0x1140, 0xFFFFFFFFu);
    appendImplicitElement(0xFFFE, 0xE000, 0xFFFFFFFFu);
    appendImplicitElement(0x0008, 0x1150, 4);
    appendStr("1.2");
    bytes.push_back(0);
    appendImplicitElement(0xFFFE, 0xE00D, 0);
    appendImplicitElement(0xFFFE, 0xE0DD, 0);

    // VOI LUT display window (DS, multi-valued per spec but this parser
    // only reads the first value) -- real-world values from the UPENN-GBM
    // bug report's own series (dump via a raw byte scan, not guessed).
    appendImplicitElement(0x0028, 0x1050, 4);  // WindowCenter = "212 "
    appendStr("212 ");
    appendImplicitElement(0x0028, 0x1051, 4);  // WindowWidth = "493 "
    appendStr("493 ");

    // Required fields, after the sequence -- proves the walk resumed
    // correctly past it rather than stopping there.
    appendImplicitElement(0x0028, 0x0002, 2);  // SamplesPerPixel = 1
    appendU16LE(1);
    appendImplicitElement(0x0028, 0x0004, 12);  // PhotometricInterpretation
    appendStr("MONOCHROME2 ");
    appendImplicitElement(0x0028, 0x0010, 2);  // Rows = 2
    appendU16LE(2);
    appendImplicitElement(0x0028, 0x0011, 2);  // Columns = 2
    appendU16LE(2);
    appendImplicitElement(0x0028, 0x0100, 2);  // BitsAllocated = 16
    appendU16LE(16);
    appendImplicitElement(0x0028, 0x0101, 2);  // BitsStored = 16
    appendU16LE(16);
    appendImplicitElement(0x0028, 0x0103, 2);  // PixelRepresentation = 0 (unsigned)
    appendU16LE(0);
    appendImplicitElement(0x7FE0, 0x0010, 8);  // PixelData, 2x2 16-bit
    appendU16LE(10);
    appendU16LE(20);
    appendU16LE(30);
    appendU16LE(40);

    std::vector<std::byte> result(bytes.size());
    for (size_t i = 0; i < bytes.size(); ++i) {
        result[i] = static_cast<std::byte>(bytes[i]);
    }
    return result;
}

void testUndefinedLengthSequenceSkipped() {
    auto const buffer = buildUndefinedLengthSequenceBuffer();
    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(buffer.data(), buffer.size(), &error);
    check(meta.has_value(), "parseFromBuffer succeeds on the undefined-length-sequence fixture");
    if (!meta) {
        return;
    }

    auto const image = dicom_parser::DicomFile::parseImageInfo(buffer.data(), buffer.size(), meta->dataSetOffset,
                                                                 meta->transferSyntaxUID, &error);
    check(image.has_value(),
          "parseImageInfo skips a well-formed undefined-length SQ element instead of failing");
    if (!image) {
        return;
    }
    checkEqU(image->rows, 2, "rows (after skipping the undefined-length sequence)");
    checkEqU(image->columns, 2, "columns (after skipping the undefined-length sequence)");
    checkEqU(image->pixelDataLength, 8, "pixelDataLength (after skipping the undefined-length sequence)");

    check(image->hasWindowCenter, "hasWindowCenter");
    check(image->hasWindowWidth, "hasWindowWidth");
    checkNear(image->windowCenter, 212.0, 1e-9, "windowCenter");
    checkNear(image->windowWidth, 493.0, 1e-9, "windowWidth");
    checkEq(image->modality, "MR", "modality");
}

void testUnsupportedTransferSyntax() {
    // Transfer-syntax dispatch happens before any buffer access, so this is
    // safe to call with an empty buffer -- exercises the rejection path for
    // compressed transfer syntaxes (docs/adr/0002), e.g. JPEG Baseline.
    dicom_parser::DicomParseError error{};
    auto const image = dicom_parser::DicomFile::parseImageInfo(nullptr, 0, 0, "1.2.840.10008.1.2.4.50", &error);
    check(!image.has_value(), "parseImageInfo rejects a compressed transfer syntax");
    check(error == dicom_parser::DicomParseError::UnsupportedTransferSyntax,
          "compressed transfer syntax reports UnsupportedTransferSyntax");
}

}  // namespace

int main() {
    testCtSmallHappyPath();
    testBufferTooSmall();
    testMissingMagic();
    testMissingGroupLengthFallback();
    testUndefinedLengthSequenceSkipped();
    testUnsupportedTransferSyntax();

    if (g_failures == 0) {
        std::printf("All dicom-parser tests passed.\n");
        return 0;
    }
    std::fprintf(stderr, "%d dicom-parser test(s) failed.\n", g_failures);
    return 1;
}
