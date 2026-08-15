# viewer

The frontend web application (REQ-R06) — the browser-side code that
eventually wraps the rendering engine's WASM module in a UI (the "Web
Application Shell") and hosts the Web Workers that feed it. Nothing in
this directory runs on a server; everything here ships as static assets
and executes entirely in the user's browser.

## What exists so far

There is no Shell yet, and no root build tooling (bundler, shared
`package.json`/workspace) — each piece below is a self-contained npm
package with its own `package.json`/`node_modules`/tests, not yet wired
together or to a live browser page. See
`docs/adr/0003-inference-worker-in-viewer.md` for why that's the
deliberate starting shape (a shared bundler setup is something whoever
scaffolds the Shell adds later, not a prerequisite for the Workers to
exist and be independently correct).

| Directory | What it does | Owner |
| --- | --- | --- |
| `src/workers/parse-worker/` | DICOM parsing (REQ-A05) — loads the shared [`dicom-parser`](../dicom-parser/README.md) WASM build, converts pixel data to Hounsfield Units, and produces both a per-slice output for the Inference Worker and an assembled volume for the rendering engine. | Engine track (blanket `/viewer/` rule in `.github/CODEOWNERS`) |
| `src/workers/inference-worker/` | AI segmentation inference (REQ-A03/A09/A16/A17) — runs a model adapter's preprocess/infer/postprocess over each Hounsfield-Unit slice the Parse Worker produces, emitting the REQ-C01 mask contract. | AI track (`CODEOWNERS` path override on this specific subtree) |

## Building and testing a package

Each package under `src/workers/` is independent — `cd` into it and use
its own `npm` scripts:

```powershell
cd viewer/src/workers/parse-worker    # or inference-worker
npm install
npm run typecheck
npm test
```

`parse-worker`'s tests load a real compiled WASM artifact
(`dicom-parser`'s `dicom_parser_wasm.mjs`), so the WASM build has to exist
first — see [`dicom-parser/README.md`](../dicom-parser/README.md#build--test)
for the CMake commands, or `viewer/src/workers/parse-worker/test/fixtures.ts`
for the exact path it expects that build output at.

## Message contracts between the pieces

The Parse Worker and Inference Worker don't call each other directly (no
shared bundler graph yet) — what connects them is a documented message
shape, not code:

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

- The Shell itself (file picking, calling into the rendering engine's WASM
  module, routing messages between the two Workers).
- A root bundler/workspace tying the packages above into one build.
- True geometric multi-file ordering (Parse Worker currently orders by
  `InstanceNumber` only — see
  [`dicom-parser/README.md`](../dicom-parser/README.md#data-model)).
