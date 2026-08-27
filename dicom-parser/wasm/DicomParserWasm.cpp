// JS-callable WASM export layer for the browser Parse Worker
// (viewer/src/workers/parse-worker/). dicom-parser's core C++ API
// (DicomFile::parseFromBuffer/parseImageInfo) is C++-only -- this file is
// the extern "C" wrapper around it, analogous to engine/src/main_wasm.cpp
// for the rendering WASM build. Not linked into that rendering build --
// this is a separate EMSCRIPTEN-only target, see CMakeLists.txt.
//
// Deliberately minimal: only the fields the Parse Worker needs (image
// geometry, pixel-data location, ordering/orientation hints, VOI LUT
// window, Modality), not the full DicomImageInfo -- e.g. no
// photometricInterpretation string (already validated inside
// parseImageInfo; JS only needs the pass/fail error code).

#include "dicom-parser/DicomFile.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <emscripten/emscripten.h>

namespace {

// Error codes returned to JS: 0 = success, else DicomParseError's
// declaration-order position + 1 (1=BufferTooSmall, 2=MissingMagic,
// 3=MissingGroupLength, 4=Truncated, 5=UnsupportedTransferSyntax,
// 6=UnsupportedSequenceEncoding, 7=UnsupportedPixelFormat,
// 8=MissingRequiredElement). Mirrored in viewer/src/workers/parse-worker/src/wasm.ts.
int errorCode(dicom_parser::DicomParseError error) {
    return static_cast<int>(error) + 1;
}

}  // namespace

// Packed output struct for dicom_wasm_parse_image -- layout is part of the
// JS<->WASM contract, so every field's offset is pinned with a
// static_assert below and JS reads the size from
// dicom_wasm_image_info_size() rather than hardcoding it.
struct DicomWasmImageInfo {
    uint32_t rows;
    uint32_t columns;
    uint32_t bitsAllocated;
    uint32_t pixelRepresentation;  // 0 = unsigned, 1 = signed
    double rescaleSlope;
    double rescaleIntercept;
    double pixelSpacingRow;
    double pixelSpacingColumn;
    double sliceThickness;
    uint32_t pixelDataOffset;  // relative to the `data` pointer passed in
    uint32_t pixelDataLength;
    int32_t instanceNumber;  // ordering hint for multi-file volume assembly; 0 if absent
    double imageOrientationPatient[6];  // row cosine [0..2] + column cosine [3..5], patient LPS space
    double imagePositionPatient[3];     // slice origin (x, y, z), patient LPS space
    uint32_t hasImageOrientationPatient;
    uint32_t hasImagePositionPatient;
    double windowCenter;  // VOI LUT display window (DICOM PS3.3 C.11.2), same units as HU
    double windowWidth;
    uint32_t hasWindowCenter;
    uint32_t hasWindowWidth;
};

static_assert(offsetof(DicomWasmImageInfo, rows) == 0);
static_assert(offsetof(DicomWasmImageInfo, columns) == 4);
static_assert(offsetof(DicomWasmImageInfo, bitsAllocated) == 8);
static_assert(offsetof(DicomWasmImageInfo, pixelRepresentation) == 12);
static_assert(offsetof(DicomWasmImageInfo, rescaleSlope) == 16);
static_assert(offsetof(DicomWasmImageInfo, rescaleIntercept) == 24);
static_assert(offsetof(DicomWasmImageInfo, pixelSpacingRow) == 32);
static_assert(offsetof(DicomWasmImageInfo, pixelSpacingColumn) == 40);
static_assert(offsetof(DicomWasmImageInfo, sliceThickness) == 48);
static_assert(offsetof(DicomWasmImageInfo, pixelDataOffset) == 56);
static_assert(offsetof(DicomWasmImageInfo, pixelDataLength) == 60);
static_assert(offsetof(DicomWasmImageInfo, instanceNumber) == 64);
static_assert(offsetof(DicomWasmImageInfo, imageOrientationPatient) == 72);
static_assert(offsetof(DicomWasmImageInfo, imagePositionPatient) == 120);
static_assert(offsetof(DicomWasmImageInfo, hasImageOrientationPatient) == 144);
static_assert(offsetof(DicomWasmImageInfo, hasImagePositionPatient) == 148);
static_assert(offsetof(DicomWasmImageInfo, windowCenter) == 152);
static_assert(offsetof(DicomWasmImageInfo, windowWidth) == 160);
static_assert(offsetof(DicomWasmImageInfo, hasWindowCenter) == 168);
static_assert(offsetof(DicomWasmImageInfo, hasWindowWidth) == 172);
static_assert(sizeof(DicomWasmImageInfo) == 176);

extern "C" {

// So JS allocates exactly sizeof(DicomWasmImageInfo) bytes rather than a
// hardcoded size that could drift from the struct above.
EMSCRIPTEN_KEEPALIVE
uint32_t dicom_wasm_image_info_size() {
    return static_cast<uint32_t>(sizeof(DicomWasmImageInfo));
}

// Parses the File Meta group. On success (return 0), *outDataSetOffset and
// outTransferSyntaxBuf (NUL-terminated, truncated to
// outTransferSyntaxBufLen - 1 bytes if needed -- transfer syntax UIDs are
// short ASCII, truncation is not expected in practice) are filled in and
// must be passed into dicom_wasm_parse_image.
EMSCRIPTEN_KEEPALIVE
int dicom_wasm_parse_meta(uint8_t const* data, size_t size, size_t* outDataSetOffset,
                           char* outTransferSyntaxBuf, size_t outTransferSyntaxBufLen) {
    auto const* bytes = reinterpret_cast<std::byte const*>(data);
    dicom_parser::DicomParseError error{};
    auto const meta = dicom_parser::DicomFile::parseFromBuffer(bytes, size, &error);
    if (!meta) {
        return errorCode(error);
    }

    *outDataSetOffset = meta->dataSetOffset;

    size_t copyLen = meta->transferSyntaxUID.size();
    if (outTransferSyntaxBufLen > 0 && copyLen > outTransferSyntaxBufLen - 1) {
        copyLen = outTransferSyntaxBufLen - 1;
    }
    if (outTransferSyntaxBufLen > 0) {
        std::memcpy(outTransferSyntaxBuf, meta->transferSyntaxUID.data(), copyLen);
        outTransferSyntaxBuf[copyLen] = '\0';
    }
    return 0;
}

// Parses the main dataset's image geometry + pixel data location.
// `pixelDataOffset` in the result is relative to `data` -- the caller
// already has the full file buffer in WASM memory (it had to, to call
// this), so pixel bytes are read from there directly rather than copied a
// second time.
// `outModalityBuf` (NUL-terminated, truncated to outModalityBufLen - 1
// bytes if needed) follows dicom_wasm_parse_meta's transferSyntaxUID
// out-buffer convention rather than a fixed-size struct field -- Modality
// (DICOM PS3.3 C.7.3.1.1.1, e.g. "CT"/"MR") is a string, and a short
// ASCII code is cheap enough to pass the same way transferSyntaxUID
// already is.
EMSCRIPTEN_KEEPALIVE
int dicom_wasm_parse_image(uint8_t const* data, size_t size, size_t dataSetOffset,
                            char const* transferSyntaxUID, DicomWasmImageInfo* out, char* outModalityBuf,
                            size_t outModalityBufLen) {
    auto const* bytes = reinterpret_cast<std::byte const*>(data);
    dicom_parser::DicomParseError error{};
    auto const image = dicom_parser::DicomFile::parseImageInfo(bytes, size, dataSetOffset,
                                                                 std::string(transferSyntaxUID), &error);
    if (!image) {
        return errorCode(error);
    }

    out->rows = image->rows;
    out->columns = image->columns;
    out->bitsAllocated = image->bitsAllocated;
    out->pixelRepresentation = image->pixelRepresentation;
    out->rescaleSlope = image->rescaleSlope;
    out->rescaleIntercept = image->rescaleIntercept;
    out->pixelSpacingRow = image->pixelSpacingRow;
    out->pixelSpacingColumn = image->pixelSpacingColumn;
    out->sliceThickness = image->sliceThickness;
    out->pixelDataOffset = static_cast<uint32_t>(image->pixelData - bytes);
    out->pixelDataLength = static_cast<uint32_t>(image->pixelDataLength);
    out->instanceNumber = image->instanceNumber;
    std::copy(std::begin(image->imageOrientationPatient), std::end(image->imageOrientationPatient),
              out->imageOrientationPatient);
    std::copy(std::begin(image->imagePositionPatient), std::end(image->imagePositionPatient),
              out->imagePositionPatient);
    out->hasImageOrientationPatient = image->hasImageOrientationPatient ? 1 : 0;
    out->hasImagePositionPatient = image->hasImagePositionPatient ? 1 : 0;
    out->windowCenter = image->windowCenter;
    out->windowWidth = image->windowWidth;
    out->hasWindowCenter = image->hasWindowCenter ? 1 : 0;
    out->hasWindowWidth = image->hasWindowWidth ? 1 : 0;

    if (outModalityBufLen > 0) {
        size_t copyLen = image->modality.size();
        if (copyLen > outModalityBufLen - 1) {
            copyLen = outModalityBufLen - 1;
        }
        std::memcpy(outModalityBuf, image->modality.data(), copyLen);
        outModalityBuf[copyLen] = '\0';
    }
    return 0;
}

}  // extern "C"

// No-op -- this module exports plain functions for JS to call directly
// (a "reactor" style WASM module, not a traditional program with real
// control flow), but Emscripten's MODULARIZE output still expects a
// main() to exist and calls it once at load time.
int main() {
    return 0;
}

