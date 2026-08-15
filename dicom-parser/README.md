# dicom-parser

A shared C++20 DICOM parsing library, consumed by two independent targets:

- OmniMed3D-Engine's native dev/test tooling (the `dicom_inspect` CLI in
  this repo, and eventually `engine/tests/parity/` fixtures).
- The browser Parse Worker, via a WASM build.

It never performs filesystem I/O itself — every entry point parses from an
in-memory buffer the caller already owns. That's what makes the same code
usable unchanged both natively and inside a browser Worker, where there is
no host filesystem to read from.

See `docs/adr/0001-shared-dicom-parser-module.md` (repo root) for why this
lives as its own top-level module rather than nested inside `engine/`, and
`engine/docs/adr/0004-shared-dicom-parser.md` for why it's one library
compiled to multiple targets rather than two independent parsers.

## Scope

| Capability | Supported? | Notes |
| --- | --- | --- |
| File Meta Information (group 0002) | Yes | SOP Class/Instance UID, Transfer Syntax UID |
| Main dataset image info | Yes | Rows/Columns/BitsAllocated/BitsStored/PixelRepresentation/SamplesPerPixel/PhotometricInterpretation/PixelSpacing/SliceThickness/RescaleSlope/RescaleIntercept, plus a view into PixelData |
| Transfer syntaxes | Explicit VR Little Endian and Implicit VR Little Endian only | Compressed transfer syntaxes (RLE, JPEG Baseline/Extended, JPEG 2000, JPEG-LS) aren't implemented — see `docs/adr/0002-dicom-parser-uncompressed-pixel-data.md` |
| Sequences (`SQ`) with undefined length | Rejected, not parsed | Fails with `UnsupportedSequenceEncoding` rather than attempting nested Item/Sequence delimiter scanning |
| Color / multi-sample pixel data | Rejected | Only `SamplesPerPixel == 1` with `PhotometricInterpretation` `MONOCHROME1`/`MONOCHROME2` is accepted |
| HU conversion (applying RescaleSlope/Intercept) | Not done here | Returns raw pixel bytes plus slope/intercept; the caller computes `HU = raw * rescaleSlope + rescaleIntercept` |
| Multi-slice volume assembly | Not this library's job | One call parses one file (one slice); ordering multiple files into a volume, and computing inter-slice spacing, is the caller's responsibility |

## Usage

```cpp
#include "dicom-parser/DicomFile.hpp"

// buffer holds an entire .dcm file's bytes, however they were obtained
// (native: read from disk; browser: bytes handed to the Parse Worker via
// the File API). The library only ever reads from it, never owns it.
std::vector<std::byte> buffer = /* ... */;

dicom_parser::DicomParseError error{};
auto const meta = dicom_parser::DicomFile::parseFromBuffer(buffer.data(), buffer.size(), &error);
if (!meta) {
    // inspect `error` -- BufferTooSmall / MissingMagic / MissingGroupLength / Truncated
    return;
}

auto const image = dicom_parser::DicomFile::parseImageInfo(
    buffer.data(), buffer.size(), meta->dataSetOffset, meta->transferSyntaxUID, &error);
if (!image) {
    // inspect `error` -- see DicomParseError values below
    return;
}

// image->pixelData / image->pixelDataLength is a *view* into `buffer` --
// valid only as long as `buffer` stays alive, never a copy.
```

This is a deliberate two-step API rather than one combined call:
`parseImageInfo` needs to know the transfer syntax (to pick the
Explicit-VR vs. Implicit-VR element-walking rule) and where the main
dataset begins (`dataSetOffset`) — both of which `parseFromBuffer` already
discovers while reading the File Meta group, so there's no need to re-walk
group 0002 a second time.

## Data model

**`DicomMetaInfo`**

| Field | Meaning |
| --- | --- |
| `mediaStorageSOPClassUID` / `mediaStorageSOPInstanceUID` / `transferSyntaxUID` | Trimmed of DICOM's even-length NUL/space padding. |
| `metaGroupLength` | Raw value of `(0002,0000)` — mostly useful for debugging. |
| `dataSetOffset` | Byte offset where the main dataset begins (right after group 0002); pass this into `parseImageInfo`. |

**`DicomImageInfo`**

| Field | Meaning |
| --- | --- |
| `rows` / `columns` | Image dimensions in pixels. |
| `bitsAllocated` / `bitsStored` | Storage width; `bitsAllocated` is what `pixelData`'s per-row stride assumes. |
| `pixelRepresentation` | `0` = unsigned, `1` = signed. Real CT data is commonly signed — confirmed against an actual sample file, not assumed. |
| `samplesPerPixel` / `photometricInterpretation` | Validated to be grayscale (`1` / `MONOCHROME1` or `MONOCHROME2`); anything else is rejected as `UnsupportedPixelFormat`. |
| `pixelSpacingRow` / `pixelSpacingColumn` | In-plane physical spacing, in mm. |
| `sliceThickness` | Through-plane thickness from *this file's own header* — not a substitute for inter-slice spacing computed across multiple files' `ImagePositionPatient` (out of scope here). |
| `rescaleSlope` / `rescaleIntercept` | Apply as `HU = raw * rescaleSlope + rescaleIntercept`. Default to `1.0`/`0.0` (per the DICOM spec) when absent from the file. |
| `pixelData` / `pixelDataLength` | A view into the buffer passed to `parseImageInfo`, not a copy. Do not use after the original buffer is freed or goes out of scope. |
| `instanceNumber` | Defaults to `0` if absent (not a parse failure). For ordering multiple files into a volume — this library never assembles a volume itself, so it's the caller's job to sort by this. Only a simple ordering hint, not a substitute for geometric ordering via `ImagePositionPatient`. |

**`DicomParseError`**

| Value | Meaning |
| --- | --- |
| `BufferTooSmall` / `MissingMagic` / `MissingGroupLength` / `Truncated` | Structural/file-format problems reading the preamble or File Meta group. |
| `UnsupportedTransferSyntax` | `transferSyntaxUID` isn't one of the two supported values. |
| `UnsupportedSequenceEncoding` | Hit an element with an undefined (`0xFFFFFFFF`) length while walking the main dataset. |
| `UnsupportedPixelFormat` | Color or multi-sample pixel data (see Scope table above). |
| `MissingRequiredElement` | One of Rows/Columns/BitsAllocated/PixelRepresentation/PixelData was absent from the dataset. |

## Build & test

This module isn't configured standalone — it's always pulled in via
`add_subdirectory()` from a consumer's own `CMakeLists.txt` (see
`engine/CMakeLists.txt` for the pattern). Build from `engine/`:

```powershell
cd engine
cmake --preset windows-default
cmake --build build
```

This produces three native-only targets (guarded by `if(NOT EMSCRIPTEN)`,
since none of them make sense in a browser build):

- **`dicom_parser`** — the static library itself (`dicom::parser` alias).
  This is the only one of the three that also builds for WASM
  (`cmake --preset wasm-windows`), since it's the one thing the browser
  Parse Worker actually needs.
- **`dicom_inspect`** — a CLI tool that parses one file and prints every
  field. Useful for manually inspecting a new or unfamiliar sample file:
  ```powershell
  ./build/dicom_inspect.exe path/to/file.dcm
  ```
- **`dicom_parser_tests`** — the automated regression suite (below).

Running the tests:

```powershell
cd engine/build
ctest --output-on-failure
```

`dicom_parser_tests` (`dicom-parser/tests/DicomFileTest.cpp`) checks:

- The full happy path against `engine/tests/fixtures/CT_small.dcm`,
  asserting every `DicomMetaInfo`/`DicomImageInfo` field against values
  hand-derived from that file's actual bytes (not assumed — dumped
  directly while designing the parser).
- Three error paths: an undersized buffer, a missing `DICM` magic, and an
  unsupported (compressed) transfer syntax.

No test-framework dependency (GoogleTest, Catch2, etc.) — checks are
plain `if`/`fprintf` assertions that increment a failure counter and set
the process exit code, which is all CTest needs (`add_test` treats a
non-zero exit as a failed test). To add a new case, extend
`DicomFileTest.cpp`'s `main()` directly; if it needs its own fixture
file, add it under `engine/tests/fixtures/` alongside `CT_small.dcm` —
only public/synthetic samples belong there, never real patient data.

## Known limitations

- **Compressed transfer syntaxes aren't implemented** (RLE, JPEG
  Baseline/Extended, JPEG 2000, JPEG-LS). See
  `docs/adr/0002-dicom-parser-uncompressed-pixel-data.md` for why, and
  when it's worth revisiting.
- **Undefined-length sequences/items anywhere in the dataset cause
  `parseImageInfo` to fail outright**, even for files that are otherwise
  fully supported — also covered in ADR-0002.
- **One call parses one file.** Assembling multiple slices into a 3D
  volume (ordering, inter-slice spacing) is caller-side work; it doesn't
  go through this library.
