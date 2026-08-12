#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace dicom_parser {

// Only the File Meta Information group (0002) is parsed -- not the main
// dataset, not pixel data. See docs/adr/0001-shared-dicom-parser-module.md
// (repo root) for why this lives in its own top-level module, and
// engine/docs/adr/0004-shared-dicom-parser.md for why the parsing scope
// itself is deliberately limited for now.
struct DicomMetaInfo {
    std::string mediaStorageSOPClassUID;
    std::string mediaStorageSOPInstanceUID;
    std::string transferSyntaxUID;
    uint32_t metaGroupLength = 0;
};

enum class DicomParseError {
    BufferTooSmall,
    MissingMagic,
    MissingGroupLength,
    Truncated,
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
};

}  // namespace dicom_parser
