# ADR-0002: `dicom-parser/` pixel data decoding — uncompressed transfer syntaxes only

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-12 |

## Context

`dicom-parser/` (`docs/adr/0001-shared-dicom-parser-module.md`) initially
only parsed the File Meta Information group (0002) — SOP Class/Instance
UID, Transfer Syntax UID. It could not produce actual image/voxel data.
This library is consumed by two independent people — the engine owner and
their partner on the Parse Worker side (`engine/docs/adr/0004-shared-dicom-parser.md`'s
"Context") — so leaving it at header-only blocked real use by both.

Extending the library to actually decode pixel data raises a scope
question: which DICOM transfer syntaxes to support. `docs/prd/PRD.md` §6.1's
tech-stack description names image decompression (JPEG 2000 / JPEG-LS) as
an eventual capability, but describes achieving it via an existing
WASM-buildable library (DCMTK/GDCM/ITK) — not a hand-written codec. This
project instead chose a lightweight from-scratch parser (ADR-0004), which
diverges from that specific approach; writing JPEG 2000/RLE/legacy-JPEG
codecs from scratch is not realistic before the project's 2026-08-27
submission deadline.

## Decision

`DicomFile::parseImageInfo(...)` (new method, alongside the existing
`parseFromBuffer`) supports exactly two transfer syntaxes:

- Explicit VR Little Endian (`1.2.840.10008.1.2.1`)
- Implicit VR Little Endian (`1.2.840.10008.1.2`)

Any other transfer syntax UID (RLE Lossless, JPEG Baseline/Extended,
JPEG 2000 Lossless/Lossy, JPEG-LS, etc.) returns
`DicomParseError::UnsupportedTransferSyntax` rather than attempting to
decode compressed pixel data.

This is recorded as a known limitation in `docs/prd/PRD.md`/`docs/ko/PRD_KO.md`
§10.1 (Risks), not just here — the practical risk is judged low because the
project's designated test/training dataset, LIDC-IDRI (`docs/prd/PRD.md`
§10.2), is predominantly distributed uncompressed.

A related, smaller scope boundary: elements with an undefined length
(`0xFFFFFFFF`, used by `SQ` sequences and encapsulated/compressed pixel
data) are detected and rejected with `DicomParseError::UnsupportedSequenceEncoding`
rather than parsed. Correctly skipping such elements requires nested
Sequence/Item delimiter scanning (a real DICOM structural feature,
independent of pixel compression) — out of scope here; failing loudly on
an unexpected undefined-length element is preferred over silently
misparsing everything downstream of it.

## Consequences

- Real-world DICOM files using JPEG 2000/JPEG-LS/RLE compressed pixel data
  will fail to decode through this library. Files must be uncompressed
  (Explicit or Implicit VR Little Endian) to work end-to-end.
- Files containing `SQ` elements with undefined length elsewhere in the
  dataset (common even in otherwise-uncompressed CT/MR studies, e.g.
  "Referenced Image Sequence") will also fail via
  `UnsupportedSequenceEncoding`, even though their pixel data itself would
  otherwise be supported. `engine/tests/fixtures/CT_small.dcm` happens to
  encode its one `SQ` element with a *defined* length, so it isn't affected
  — this is a real gap for other real-world files, not just a theoretical
  one.
- If a genuine need for compressed-transfer-syntax or undefined-length
  support surfaces (e.g. a real LIDC-IDRI file that doesn't parse), revisit
  this decision then rather than pre-building support speculatively now.

## Alternatives Considered

- **Implement RLE decoding now, defer JPEG 2000/JPEG-LS.** RLE (PackBits-style,
  DICOM PS3.5 Annex G) is comparatively simple to implement from scratch
  compared to JPEG 2000. Not adopted for this pass — the designated test
  dataset doesn't currently demonstrate a need for it, and the PRD's own
  §10.1 risk entry treats "revisit if a compressed-format need surfaces" as
  the right trigger, not speculative pre-work under deadline pressure.
- **Adopt an existing WASM-buildable library (DCMTK/GDCM/ITK) instead of
  extending the from-scratch parser**, matching what PRD §6.1 originally
  described. Not adopted: this would reverse ADR-0004's decision, requires
  a new dependency (`claude.md` §4 — not to be added without explicit
  consent), and there isn't schedule room to evaluate and integrate a large
  third-party DICOM toolkit before the deadline.
