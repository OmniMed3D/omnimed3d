# viewer

The frontend web application (REQ-R06) — the browser-side code that
eventually wraps the rendering engine's WASM module in a UI (the "Web
Application Shell") and hosts the Web Workers that feed it. Nothing in
this directory runs on a server; everything here ships as static assets
and executes entirely in the user's browser.

## What exists so far

`viewer/` is an npm workspace root (Vite + npm workspaces, decided in
`docs/prd/PRD.md` §6.1 resolving issue #21) — one `npm install` at this
directory hoists dependencies for every package below, and `npm run
build`/`npm run dev` at this root drive the Vite build across all of
them. See `docs/adr/0003-inference-worker-in-viewer.md` for why the
workspace didn't exist until now (it was deferred to whoever scaffolded
the Shell) and each package's own `package.json` for what it still owns
independently (its own dependencies, `typecheck`/`test` scripts).

| Directory | What it does | Owner |
| --- | --- | --- |
| `src/shell/` | Toolchain smoke entry only — proves Vite can bundle a Worker entry from a sibling workspace package. **Not** the real Web Application Shell (REQ-R06: file picking, calling into the rendering engine's WASM module, routing messages between the two Workers below) — that's still unbuilt. | Engine track (blanket `/viewer/` rule in `.github/CODEOWNERS`) |
| `src/workers/parse-worker/` | DICOM parsing (REQ-A05) — loads the shared [`dicom-parser`](../dicom-parser/README.md) WASM build, converts pixel data to Hounsfield Units, and produces both a per-slice output for the Inference Worker and an assembled volume for the rendering engine. | Engine track (blanket `/viewer/` rule in `.github/CODEOWNERS`) |
| `src/workers/inference-worker/` | AI segmentation inference (REQ-A03/A09/A16/A17) — runs a model adapter's preprocess/infer/postprocess over each Hounsfield-Unit slice the Parse Worker produces, emitting the REQ-C01 mask contract. | AI track (`CODEOWNERS` path override on this specific subtree) |

## Building and testing

Install once at the workspace root, then use the root scripts (which
delegate to each package via `npm --workspaces`) or `cd` into a specific
package for its own scripts:

```zsh
cd viewer
npm install
npm run typecheck   # all packages
npm test             # all packages
npm run build        # vite build, src/shell/ smoke entry -> dist/
npm run dev           # vite dev server, src/shell/ smoke entry
```

`parse-worker`'s tests load a real compiled WASM artifact
(`dicom-parser`'s `dicom_parser_wasm.mjs`), so the WASM build has to exist
first — see [`dicom-parser/README.md`](../dicom-parser/README.md#build--test)
for the CMake commands, or `viewer/src/workers/parse-worker/test/fixtures.ts`
for the exact path it expects that build output at. `inference-worker`'s
model-fixture tests similarly need `ai-pipeline/quantization/calibration_data/`
generated locally first (gitignored, not part of a fresh clone) — see
`src/workers/inference-worker/scripts/export_reference_fixtures.py`.

## Message contracts between the pieces

The Parse Worker and Inference Worker don't call each other directly —
they're both bundled by the same Vite workspace now, but nothing yet
constructs one from inside the other's code. What connects them is a
documented message shape, not code:

- `hu-slice` (Parse Worker → Inference Worker): defined in
  `src/workers/inference-worker/src/worker.ts`'s `HuSliceMessage` and
  matched field-for-field by `src/workers/parse-worker/src/pipeline.ts`.
- `mask-slice` (Inference Worker → rendering engine, via the Shell once it
  exists): PRD §5.3.2, implemented in
  `src/workers/inference-worker/src/pipeline.ts`'s `MaskSliceMessage`.
- `volume-ready` (Parse Worker → rendering engine, via the Shell once it
  exists): `src/workers/parse-worker/src/pipeline.ts`'s
  `VolumeReadyMessage` — matches
  `rhi::Device::loadVolume`/`engine_load_volume`'s parameters exactly
  (`engine/src/rhi/include/rhi/Device.hpp`, `engine/src/main_wasm.cpp`).

None of these have been exercised in a real browser yet — `parse-worker`
and `inference-worker` are each verified independently (against real
WASM/model output respectively), not against each other or against a live
`rhi::Device`, which needs a real WebGPU context (unavailable under Node)
and the Shell (not started) to actually route messages between them.

## What's not here yet

- The real Shell (file picking, calling into the rendering engine's WASM
  module, routing messages between the two Workers) — `src/shell/`
  currently holds only the toolchain smoke entry described above.
- True geometric multi-file ordering (Parse Worker currently orders by
  `InstanceNumber` only — see
  [`dicom-parser/README.md`](../dicom-parser/README.md#data-model)).
