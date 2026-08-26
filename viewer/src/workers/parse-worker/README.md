# parse-worker

DICOM parsing (REQ-A05) — the Web Worker that loads the shared
[`dicom-parser`](../../../../dicom-parser/README.md) WASM build, converts
raw pixel data to Hounsfield Units, and produces both a per-slice output
for the Inference Worker and an assembled multi-file volume for the
rendering engine. Engine-track scope (blanket `/viewer/` rule in
[`.github/CODEOWNERS`](../../../../.github/CODEOWNERS)), unlike its
sibling [`inference-worker/`](../inference-worker/README.md).

## Layout

| Path | What it does |
| --- | --- |
| `src/wasm.ts` | Thin typed wrapper over `dicom-parser`'s WASM export layer (`dicom-parser/wasm/DicomParserWasm.cpp`) — no Node-specific APIs, so it works unchanged inside a real browser Worker. |
| `src/pipeline.ts` | Pure, environment-agnostic DICOM → Hounsfield-Unit conversion: `parseSliceToHu` (one file → one `HuSliceMessage`) and `assembleSeries` (a whole series' files → `hu-slice` messages for every slice, one `volume-ready` message for `engine_load_volume`, and one `native-volume-ready` message for `engine_load_native_volume`'s MPR/native-slice view). 16-bit pixel data only (signed or unsigned) — the only case verified against real bytes so far. |
| `src/orientation.ts` | Pure geometry: normalizes `ImageOrientationPatient`/`ImagePositionPatient` into one canonical LPS pixel-data orientation so `hu-slice`/`volume-ready` output never depends on which DICOM row/column convention (HFS/FFS/HFP/FFP, etc.) a file used. Axis-aligned acquisitions take a fast path; a genuinely oblique series (e.g. neuro MR angled off axial) is resampled onto a canonical grid via trilinear interpolation (`computeObliqueResampleGrid`/`canonicalToSourceIndex`) rather than rejected. |
| `src/halfFloat.ts` | `float32ToFloat16` — plain bit-manipulation IEEE 754 binary16 conversion (no `Float16Array` dependency, for broader engine support). `rhi::Device::loadVolume`/`engine_load_volume` upload their input buffer directly into an `R16Float` GPU texture, so the caller has to have already converted to this format. |
| `src/worker.ts` | The actual `self.onmessage` entry point: `init` (loads the WASM module, acks with `init-complete`), `parse-file` (Inference-Worker leg only), `parse-series` (both legs — every `hu-slice` plus `volume-ready` plus `native-volume-ready`, in that order). A thrown error inside the async handler is caught and reported as a `parse-error` message rather than surfacing as an uncaught worker error. |
| `test/` | Vitest unit suite — see "Testing" below. |

## Testing

```sh
cd viewer/src/workers/parse-worker
npm run typecheck
npm test
```

The suite loads a real compiled WASM artifact
(`dicom-parser`'s `dicom_parser_wasm.mjs`), so the WASM build has to
exist first:

```powershell
cd engine
./scripts/emsdk-shell.ps1 "cmake --preset wasm-windows" -EmsdkDir C:\dev\emsdk   # or emsdk-shell.sh / wasm-macos
./scripts/emsdk-shell.ps1 "cmake --build build_wasm" -EmsdkDir C:\dev\emsdk
```

`test/fixtures.ts` expects the built module at
`engine/build_wasm/dicom-parser/dicom_parser_wasm.mjs` and the sample
file at `engine/tests/fixtures/CT_small.dcm`.

- `pipeline.test.ts` — `parseSliceToHu` against a real DICOM file, and
  the 16-bit-only rejection path (`UnsupportedPixelDataError`).
- `assembleSeries.test.ts` — multi-file series assembly: geometric
  ordering via `ImagePositionPatient`, inter-slice spacing, the
  `volume-ready`/`native-volume-ready` split, and the `instanceNumber`
  fallback when orientation tags are missing.
- `orientation.test.ts` — pure-geometry unit tests for
  `orientation.ts`'s axis classification, canonical-transform
  computation, and the oblique-resample grid, independent of any WASM
  build.
- `halfFloat.test.ts` — `float32ToFloat16` against known reference bit
  patterns (normal, subnormal, zero, overflow-to-infinity, NaN), not
  just the Hounsfield-range values this module needs in practice.

Browser integration (a real Worker, real WASM, driven by the Shell) is
covered from the other side, in
[`viewer/tests/e2e/`](../../../README.md#browser-e2e-tests-testse2e) —
this package's own suite runs entirely under Node.

## Message contracts

See [`viewer/README.md`](../../../README.md#message-contracts-between-the-pieces)
for the full routing picture (`src/shell/main.ts` is what actually wires
this worker to the Inference Worker and the Engine). Summary of what
this worker emits:

| Message | Consumer | Notes |
| --- | --- | --- |
| `init-complete` | Shell | Acks that the async WASM load finished — a caller that sends `parse-file`/`parse-series` before this lands races the load. |
| `hu-slice` | Shell → Inference Worker | One 2D slice, original resolution, Hounsfield Units, float32. Matches `inference-worker`'s `HuSliceMessage` field-for-field. |
| `volume-ready` | Shell → `engine_load_volume` | The assembled, canonical-LPS-oriented (possibly resampled) volume. Optional `windowCenter`/`windowWidth` carry the series' own DICOM VOI LUT display window when present (added 2026-08-27 — lets the Shell display non-CT data like MR correctly instead of assuming a CT-calibrated preset). |
| `native-volume-ready` | Shell → `engine_load_native_volume` | The series' own original per-file slices, native order/resolution, entirely separate from `volume-ready` (MPR + native-slice feature, 2026-08-27). Always produced, even for an already axis-aligned series. |
| `parse-error` | Shell | A bad/unsupported file (`UnsupportedPixelDataError`, `InconsistentSeriesError`, or a `dicom-parser` WASM throw), reported rather than left as an uncaught worker error. |

## What's not here yet

- Compressed transfer syntaxes and multi-sample/color pixel data — both
  rejected at the `dicom-parser` layer; see
  [`dicom-parser/README.md`](../../../../dicom-parser/README.md)'s
  "Known limitations".
- Chunked/streaming parsing for multi-gigabyte series — a whole series'
  files are parsed in one `parse-series` call today.
- Anatomical verification of orientation normalization against a real
  multi-slice series with known left/right anatomy — no suitable
  fixture exists yet; only synthetic hand-computed cases and the real
  UPENN-GBM series are verified so far (`orientation.ts`'s own module
  doc comment has the full scope of what's normalized and how).
- The oblique-resample fallback (`orientation.ts`) only activates for a
  genuinely oblique *acquisition* going through `assembleSeries`
  (`parse-series`) — the single-file streaming path (`parseSliceToHu`,
  `parse-file`) has no series-wide context to resample against, and
  still throws `UnsupportedOrientationError` for a non-axis-aligned
  slice.
