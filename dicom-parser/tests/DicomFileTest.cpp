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
    testUnsupportedTransferSyntax();

    if (g_failures == 0) {
        std::printf("All dicom-parser tests passed.\n");
        return 0;
    }
    std::fprintf(stderr, "%d dicom-parser test(s) failed.\n", g_failures);
    return 1;
}
