// Native-only CLI tool proving the shared DICOM parser (repo-root
// dicom-parser/, docs/adr/0001-shared-dicom-parser-module.md) works
// against a real file. Not built for WASM -- the browser Parse Worker gets
// bytes from the File API via JS, never reads a file itself (CLAUDE.md #9).

#include "dicom-parser/DicomFile.hpp"

#include <cstdio>
#include <fstream>
#include <iterator>
#include <vector>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: dicom_inspect <path-to-dicom-file>\n");
        return 1;
    }

    std::ifstream file(argv[1], std::ios::binary);
    if (!file) {
        std::fprintf(stderr, "error: could not open '%s'\n", argv[1]);
        return 1;
    }

    std::vector<char> const buffer((std::istreambuf_iterator<char>(file)),
                                    std::istreambuf_iterator<char>());

    auto const* bytes = reinterpret_cast<std::byte const*>(buffer.data());
    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(bytes, buffer.size(), &error);

    if (!meta) {
        std::fprintf(stderr, "failed to parse '%s' (error code %d)\n", argv[1], static_cast<int>(error));
        return 1;
    }

    std::printf("File: %s\n", argv[1]);
    std::printf("  File Meta Group Length:         %u\n", meta->metaGroupLength);
    std::printf("  Media Storage SOP Class UID:    %s\n", meta->mediaStorageSOPClassUID.c_str());
    std::printf("  Media Storage SOP Instance UID: %s\n", meta->mediaStorageSOPInstanceUID.c_str());
    std::printf("  Transfer Syntax UID:            %s\n", meta->transferSyntaxUID.c_str());

    auto const image = dicom_parser::DicomFile::parseImageInfo(bytes, buffer.size(), meta->dataSetOffset,
                                                                 meta->transferSyntaxUID, &error);
    if (!image) {
        std::fprintf(stderr, "failed to parse image data from '%s' (error code %d)\n", argv[1],
                     static_cast<int>(error));
        return 1;
    }

    std::printf("  Rows x Columns:                 %u x %u\n", image->rows, image->columns);
    std::printf("  Bits Allocated / Stored:        %u / %u\n", image->bitsAllocated, image->bitsStored);
    std::printf("  Pixel Representation:           %u (%s)\n", image->pixelRepresentation,
                 image->pixelRepresentation == 0 ? "unsigned" : "signed");
    std::printf("  Samples Per Pixel:              %u\n", image->samplesPerPixel);
    std::printf("  Photometric Interpretation:     %s\n", image->photometricInterpretation.c_str());
    std::printf("  Pixel Spacing (row, column):    %g, %g\n", image->pixelSpacingRow, image->pixelSpacingColumn);
    std::printf("  Slice Thickness:                %g\n", image->sliceThickness);
    std::printf("  Rescale Slope / Intercept:      %g / %g\n", image->rescaleSlope, image->rescaleIntercept);
    std::printf("  Pixel Data Length:              %zu bytes\n", image->pixelDataLength);
    return 0;
}
