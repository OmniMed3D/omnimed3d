#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace dicom_parser {

// File Meta Information group (0002) only -- SOP Class/Instance UID,
// Transfer Syntax UID. See DicomFile::parseImageInfo() below for the main
// dataset (image geometry + pixel data). See
// docs/adr/0001-shared-dicom-parser-module.md (repo root) for why this
// library lives in its own top-level module.
struct DicomMetaInfo {
    std::string mediaStorageSOPClassUID;
    std::string mediaStorageSOPInstanceUID;
    std::string transferSyntaxUID;
    uint32_t metaGroupLength = 0;

    // Byte offset where the main dataset begins (right after group 0002) --
    // callers pass this into parseImageInfo() so it doesn't have to re-walk
    // the meta group to find where its own job starts.
    size_t dataSetOffset = 0;
};

enum class DicomParseError {
    BufferTooSmall,
    MissingMagic,
    MissingGroupLength,
    Truncated,

    // Errors specific to parseImageInfo() -- main dataset / pixel data.
    UnsupportedTransferSyntax,   // not Explicit or Implicit VR Little Endian
    UnsupportedSequenceEncoding, // an undefined-length (0xFFFFFFFF) SQ
                                  // element's Item/delimiter structure was
                                  // malformed or truncated -- well-formed
                                  // undefined-length sequences are skipped,
                                  // not rejected (see docs/adr/0002's
                                  // "revisit this decision" note)
    UnsupportedPixelFormat,      // SamplesPerPixel != 1, PhotometricInterpretation
                                  // not MONOCHROME1/2, or PixelData has an
                                  // undefined/encapsulated length (compressed)
    MissingRequiredElement,      // Rows/Columns/BitsAllocated/PixelRepresentation
                                  // /PixelData absent from the dataset
};

// Geometry + pixel data for one DICOM image (one file = one slice). HU
// conversion (raw * rescaleSlope + rescaleIntercept) is left to the caller --
// this struct exposes the raw ingredients, not a converted buffer, so it
// doesn't have to allocate or pick an output numeric type on the caller's
// behalf.
struct DicomImageInfo {
    uint16_t rows = 0;
    uint16_t columns = 0;
    uint16_t bitsAllocated = 0;
    uint16_t bitsStored = 0;
    uint16_t pixelRepresentation = 0; // 0 = unsigned, 1 = signed
    uint16_t samplesPerPixel = 0;
    std::string photometricInterpretation;
    double rescaleSlope = 1.0;
    double rescaleIntercept = 0.0;
    double pixelSpacingRow = 0.0;
    double pixelSpacingColumn = 0.0;
    double sliceThickness = 0.0;

    // Defaults to 0 if the tag is absent -- Instance Number is commonly
    // present but not hard-required by every IOD, so a missing value is
    // not treated as a parse failure. Used by multi-file callers to order
    // slices into a volume (see viewer/src/workers/parse-worker/); this
    // library itself never assembles multiple files.
    int32_t instanceNumber = 0;

    // Row direction cosine [0..2] + column direction cosine [3..5], and
    // the slice origin, both in patient LPS space (DICOM PS3.3
    // C.7.6.2.1.1) -- always in LPS regardless of PatientPosition, which
    // describes how the patient was fed into the scanner, not a different
    // coordinate convention for these tags. Presence flags because
    // (0,0,0)/identity are legitimate real values too, same reasoning as
    // instanceNumber defaulting rather than hard-failing when absent.
    // Geometric slice ordering and orientation normalization are caller
    // responsibilities (see viewer/src/workers/parse-worker/src/orientation.ts)
    // -- this library only exposes the raw values.
    double imageOrientationPatient[6] = {1, 0, 0, 0, 1, 0};
    double imagePositionPatient[3] = {0, 0, 0};
    bool hasImageOrientationPatient = false;
    bool hasImagePositionPatient = false;

    // VOI LUT display window (DICOM PS3.3 C.11.2) -- the scanner/PACS's own
    // recommendation for how to map pixel values (after Rescale
    // Slope/Intercept, i.e. the same units as the HU the caller computes)
    // to a display range. Real clinical viewers read this per-image rather
    // than guessing a fixed window; a caller applying a generic modality
    // preset instead (e.g. a CT Hounsfield-Unit window against MR data
    // whose intensity scale isn't HU at all) can produce a wildly
    // wrong-looking image even though nothing failed to parse -- bug
    // report, 2026-08-27 (UPENN-GBM brain MR rendered as a blown-out white
    // block under the app's CT "Brain" preset). Both tags are multi-valued
    // per spec (multiple VOI LUT windows); only the first is exposed here,
    // same simplification as pixelSpacing/rescaleSlope. Presence flags for
    // the same reason as imageOrientationPatient/imagePositionPatient --
    // 0 is a legitimate real value too.
    double windowCenter = 0.0;
    double windowWidth = 0.0;
    bool hasWindowCenter = false;
    bool hasWindowWidth = false;

    // Modality (DICOM PS3.3 C.7.3.1.1.1, e.g. "CT", "MR") -- callers were
    // using "does this file carry a VOI LUT window" as a proxy for "is this
    // non-HU data", but real CT commonly carries one too (bug report,
    // 2026-08-27: a CT series' own VOI LUT window got auto-selected over
    // the app's ordinary CT presets). Modality is the actual signal for
    // that decision; exposed as the raw two-letter code (empty if absent),
    // same "no presence flag, empty string means absent" convention as
    // photometricInterpretation above.
    std::string modality;

    // View into the caller's original buffer -- never a copy (ADR-0004's
    // zero-copy philosophy). Valid only as long as that buffer is alive.
    std::byte const* pixelData = nullptr;
    size_t pixelDataLength = 0;
};

// Parses the 128-byte preamble + "DICM" magic + File Meta Information group
// (0002) from an in-memory DICOM file buffer. Never performs filesystem I/O
// -- this is what makes it usable from both native tooling and the (future)
// browser Parse Worker unchanged (CLAUDE.md #9 "No host filesystem on
// WASM"). Callers that need to read from disk (native only) do so
// separately and pass the resulting buffer in.
class DicomFile {
public:
    static std::optional<DicomMetaInfo> parseFromBuffer(std::byte const* data, size_t size,
                                                          DicomParseError* outError = nullptr);

    // Parses the main dataset's image geometry + pixel data. `dataSetOffset`
    // and `transferSyntaxUID` come from a prior parseFromBuffer() call --
    // this is a deliberate two-step API (not a combined one-call parse)
    // because the caller must already know the transfer syntax before it can
    // decide how to walk the main dataset, same as a future Parse Worker
    // would. Only uncompressed Explicit/Implicit VR Little Endian are
    // supported -- see docs/adr/0002-dicom-parser-uncompressed-pixel-data.md
    // (repo root) for why.
    static std::optional<DicomImageInfo> parseImageInfo(std::byte const* data, size_t size,
                                                          size_t dataSetOffset,
                                                          std::string const& transferSyntaxUID,
                                                          DicomParseError* outError = nullptr);
};

}  // namespace dicom_parser
