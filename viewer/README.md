# viewer

The frontend web application (REQ-R06) — the browser-side code that
eventually wraps the rendering engine's WASM module in a UI (the "Web
Application Shell") and hosts the Web Workers that feed it. Nothing in
this directory runs on a server; everything here ships as static assets
and executes entirely in the user's browser.

## What exists so far

`viewer/` is an npm workspace root (Vite + npm workspaces, decided in
`docs/prd/PRD.md` §6.1 resolving issue #20's Step 0) — one `npm install`
at this directory hoists dependencies for every package below, and `npm
run build`/`npm run dev` at this root drive the Vite build across all of
them. See `docs/adr/0003-inference-worker-in-viewer.md` for why the
workspace didn't exist until now (it was deferred to whoever scaffolded
the Shell) and each package's own `package.json` for what it still owns
independently (its own dependencies, `typecheck`/`test` scripts).

| Directory | What it does | Owner |
| --- | --- | --- |
| `src/shell/` | Real message routing and Engine WASM wiring: mints/tracks `volumeId`, routes `hu-slice` → Inference Worker, `volume-ready` → `engine_load_volume`, `mask-slice` → `engine_apply_mask_slice` (discarding stale-`volumeId` slices per PRD §5.3.2), all verified against real Workers in a real browser (`tests/e2e/`). As of issue #34, also the real Web Application Shell UI (REQ-R06): a file picker (`filePicker.ts`), mouse-driven orbit camera (`cameraControls.ts`), and a window/level panel (`windowLevelControls.ts`). As of issue #37, also a 3D-orbit/2D-axial-slice view-mode toggle plus a slice slider (`viewControls.ts`), completing PRD §9's rotate/zoom/slice-pan success criterion. As of issue #40, the canvas is responsive (`canvasResize.ts`, a `ResizeObserver`-driven `engine_resize`) instead of a fixed 640x480 box, and a WebGPU-unavailable browser/device shows a plain-language error (`#engine-error`) instead of an indefinite "loading" state — `window.omnimed3dTestHooks` stays available alongside all of these for `tests/e2e/`, sharing the same underlying Worker instances. | Engine track (blanket `/viewer/` rule in `.github/CODEOWNERS`) |
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
npm test             # all packages (unit-level, vitest)
npm run build        # vite build, src/shell/ -> dist/
npm run dev           # vite dev server, src/shell/ (foreground)
```

To run the dev server in the background instead of tying up a terminal
(`scripts/dev-server.ps1`, Windows only -- tracks the process via a PID
file so it can be stopped cleanly, child processes included):

```powershell
npm run dev:start    # starts in the background, prints the URL
npm run dev:status   # is it running?
npm run dev:stop     # stops it (and its child node/vite processes)
```

`parse-worker`'s tests load a real compiled WASM artifact
(`dicom-parser`'s `dicom_parser_wasm.mjs`), so the WASM build has to exist
first — see [`dicom-parser/README.md`](../dicom-parser/README.md#build--test)
for the CMake commands, or `viewer/src/workers/parse-worker/test/fixtures.ts`
for the exact path it expects that build output at. `inference-worker`'s
model-fixture tests similarly need `ai-pipeline/quantization/calibration_data/`
generated locally first (gitignored, not part of a fresh clone) — see
`src/workers/inference-worker/scripts/export_reference_fixtures.py`.

### Browser e2e tests (`tests/e2e/`)

Verifies the real Shell against real Workers in a real browser
(Playwright + Chromium) — see `tests/e2e/shell-mask-integration.spec.ts`'s
own doc comment for exactly what each of its 6 tests checks, including
real visual (screenshot-diff) assertions against real DICOM data (issue
number 29), the real UI shell driven end-to-end (issue number 34), the
3D/2D view-mode toggle + slice slider (issue number 37), and the
responsive canvas at both desktop and sub-640px mobile viewport widths
(issue number 40) — see "What's not here yet" for what's still
deliberately out of scope. One-time setup, then per-run:

```zsh
# One-time (per machine):
npx playwright install chromium

# Every run, in order:
cd engine && cmake --preset wasm-macos && cmake --build build_wasm   # or wasm-windows
cd ../viewer
npm run sync-engine-wasm   # copies engine/build_wasm/* into src/shell/public/engine/
npm run test:e2e
```

Headless Chromium needs explicit GPU flags to expose a WebGPU adapter at
all (`playwright.config.ts`'s `launchOptions.args` — confirmed via
`navigator.gpu.requestAdapter()` returning `null` without them, not
assumed); the macOS-specific flag there (`--use-angle=metal`) would need
an equivalent for other host OSes.

## Message contracts between the pieces

The Parse Worker and Inference Worker don't call each other directly —
`src/shell/main.ts` is what constructs both and routes messages between
them and into the Engine WASM module:

- `hu-slice` (Parse Worker → Shell → Inference Worker): defined in
  `src/workers/inference-worker/src/worker.ts`'s `HuSliceMessage` and
  matched field-for-field by `src/workers/parse-worker/src/pipeline.ts`.
- `mask-slice` (Inference Worker → Shell → `engine_apply_mask_slice`):
  PRD §5.3.2, implemented in
  `src/workers/inference-worker/src/pipeline.ts`'s `MaskSliceMessage`.
- `volume-ready` (Parse Worker → Shell → `engine_load_volume`):
  `src/workers/parse-worker/src/pipeline.ts`'s
  `VolumeReadyMessage` — matches
  `rhi::Device::loadVolume`/`engine_load_volume`'s parameters exactly
  (`engine/src/rhi/include/rhi/Device.hpp`, `engine/src/main_wasm.cpp`).

This routing is verified end-to-end in a real browser via
`tests/e2e/shell-mask-integration.spec.ts`: real DICOM bytes through a
real Parse Worker, a real (dummy-model, plumbing-only) Inference Worker
round trip, out-of-order slice delivery, and stale-`volumeId` rejection
all confirmed against the Engine's own WASM exports — not just each
piece independently anymore. That same spec file's second test (issue
number 29) confirms the real render pass now visually reflects real
DICOM data too: a screenshot taken after a real volume loads is
asserted to differ from the flat clear-color baseline taken before it.
On Windows,
running this suite needs `channel: "chrome"` (the real system Chrome
install, not Playwright's own bundled Chromium test build) —
`playwright.config.ts` picks this automatically by OS; see its comment
for why (a Dawn/D3D12 DXC shader-compiler DLL-loading issue specific to
Playwright's bundled build).

## What's not here yet

- Inference Worker/model-loading UI — not wired up yet (issue #34's
  explicit scope boundary; the repo's only model fixture is a dummy,
  plumbing-only ONNX graph with nothing real to point a "load model"
  control at). Loading a volume via the file picker with no model loaded
  is a supported, non-error state — `hu-slice` messages are dropped with
  a console log rather than forwarded, until a model is initialized
  (currently only `omnimed3dTestHooks.inferenceWorker` can do that).
- Mobile touch/pinch input for the camera — mouse-driven controls only
  (issue #34's explicit scope boundary).
- Aspect-ratio-correct letterboxing for the 2D axial slice view (issue
  #37) when voxel spacing is non-square — the MVP fills the canvas
  edge-to-edge, matching the 3D raymarch pipeline's own fixed-canvas,
  no-DPR-correction posture.
- Sagittal/coronal slice axes for the 2D slice view (issue #37) — axial
  only, matching REQ-R02 and the Parse Worker's own axial-only scope
  below.
- Anatomical verification of orientation normalization against a real
  multi-slice series with known left/right anatomy — no suitable fixture
  exists yet (see "DICOM orientation normalization" below); only
  synthetic hand-computed cases are verified so far.
- Sagittal/coronal/oblique DICOM acquisitions — the Parse Worker only
  supports axial series (slice normal resolves to the patient Z axis);
  anything else is rejected with `UnsupportedOrientationError` rather
  than silently mishandled.

## DICOM orientation normalization

`src/workers/parse-worker/src/orientation.ts` normalizes every slice's
pixel data to one canonical convention before it leaves the Parse
Worker, regardless of which of DICOM's several equally-valid
acquisition conventions (HFS/FFS/HFP/FFP, etc.) the source series used.
Both `hu-slice` and `volume-ready` output are guaranteed to already be
in this orientation — downstream consumers (Inference Worker, Engine)
need no orientation-handling code of their own, only this assumption:

- Column-index-increasing = patient **Left** (+X)
- Row-index-increasing = patient **Posterior** (+Y)
- Slice-index-increasing = patient **Superior** (+Z)

i.e. **LPS**, matching common medical-imaging tooling's default (e.g.
ITK). This is derived from each file's `ImageOrientationPatient` (0020,0037)
and `ImagePositionPatient` (0020,0032) tags — both always expressed in
patient LPS space regardless of `PatientPosition` (which describes how
the patient was fed into the scanner, not a different coordinate
convention for these tags).

Scope: **axial acquisitions only** — the slice normal
(`cross(rowCosine, columnCosine)`) must resolve to the patient Z axis.
Row/column can be any axis-aligned permutation of ±X/±Y (covering
realistic HFS/FFS/HFP/FFP variation), so both transpose and flip
transforms are applied as needed, but sagittal/coronal/oblique
acquisitions are rejected outright (`UnsupportedOrientationError`), not
silently misparsed.

If a slice is missing either tag, its pixel data passes through
unchanged (`console.warn`), and `assembleSeries` falls back to ordering
by `InstanceNumber` instead of true geometric position — see
[`dicom-parser/README.md`](../dicom-parser/README.md#data-model) for
that fallback's own caveats. The result's `orderingMethod` field
(`"geometric"` or `"instanceNumber"`) reports which path was taken.
