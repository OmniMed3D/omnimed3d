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

| Directory                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owner                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/shell/`                    | Real message routing and Engine WASM wiring: mints/tracks `volumeId`, routes `hu-slice` → Inference Worker, `volume-ready` → `engine_load_volume`, `mask-slice` → `engine_apply_mask_slice` (discarding stale-`volumeId` slices per PRD §5.3.2), all verified against real Workers in a real browser (`tests/e2e/`). As of issue #34, also the real Web Application Shell UI (REQ-R06): a file picker (`filePicker.ts`), mouse-driven orbit camera (`cameraControls.ts`), and a window/level panel (`windowLevelControls.ts`). As of issue #37, also a 3D-orbit/2D-axial-slice view-mode toggle plus a slice slider (`viewControls.ts`), completing PRD §9's rotate/zoom/slice-pan success criterion. As of issue #40, the canvas is responsive (`canvasResize.ts`, a `ResizeObserver`-driven `engine_resize`) instead of a fixed 640x480 box, and a WebGPU-unavailable browser/device shows a plain-language error (`#engine-error`) instead of an indefinite "loading" state. As of issue #42, a loading indicator (`loadingIndicator.ts`) shows between file selection and the volume rendering, and interactive touch targets meet a 44px minimum at the mobile breakpoint. A subsequent visual-polish pass added: a teal design-token system replacing scattered hardcoded colors (`style.css`'s `:root`); a draggable, collapsible control panel (`panelDrag.ts`, runtime-only position/state, resets on reload); a "Load Demo Model" button (`inferenceControls.ts`) wiring the previously test-hooks-only Inference Worker init path into the real UI; direct numeric entry for Window Center/Width alongside their sliders (`windowLevelControls.ts`'s `bindRangeWithNumericEntry`); a plain-language `#load-error` message on an unparseable file (`worker.ts`'s caught-and-reported `parse-error` message, since a throw inside its `async onmessage` doesn't reach the main thread's `onerror`); and folder-picker junk-file filtering (`filePicker.ts`'s `isLikelyNonDicom`, deny-list based since real DICOM files often have no extension) — `window.omnimed3dTestHooks` stays available alongside all of these for `tests/e2e/`, sharing the same underlying Worker instances. | Engine track (blanket `/viewer/` rule in `.github/CODEOWNERS`) |
| `src/workers/parse-worker/`     | DICOM parsing (REQ-A05) — loads the shared [`dicom-parser`](../dicom-parser/README.md) WASM build, converts pixel data to Hounsfield Units, and produces both a per-slice output for the Inference Worker and an assembled volume for the rendering engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Engine track (blanket `/viewer/` rule in `.github/CODEOWNERS`) |
| `src/workers/inference-worker/` | AI segmentation inference (REQ-A03/A09/A16/A17) — runs a model adapter's preprocess/infer/postprocess over each Hounsfield-Unit slice the Parse Worker produces, emitting the REQ-C01 mask contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | AI track (`CODEOWNERS` path override on this specific subtree) |

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
(`scripts/dev-server.ps1`/`.sh` -- tracks the process via a PID file so
it can be stopped cleanly, child processes included):

```powershell
npm run dev:start    # Windows
npm run dev:status
npm run dev:stop
```

```zsh
npm run dev:start:mac   # macOS/Linux
npm run dev:status:mac
npm run dev:stop:mac
```

For local iteration on the engine specifically, `dev:full`/`dev:full:mac`
(`scripts/dev-full.ps1`/`.sh`) collapses the whole edit-rebuild-reload
loop into one command: rebuild the engine's WASM target
(`engine/scripts/wasm-build.ps1`/`.sh`), run `sync-engine-wasm` (below),
then start the dev server the same way `dev:start`/`dev:start:mac`
does -- so `dev:status`/`dev:stop` still apply afterward.

```powershell
npm run dev:full         # Windows
npm run dev:full:mac     # macOS/Linux
```

Neither variant runs `sync-demo-ct` (below) -- that only needs
re-running when the demo DICOM data itself changes, not on every engine
rebuild.

`parse-worker`'s tests load a real compiled WASM artifact
(`dicom-parser`'s `dicom_parser_wasm.mjs`), so the WASM build has to exist
first — see [`dicom-parser/README.md`](../dicom-parser/README.md#build--test)
for the CMake commands, or `viewer/src/workers/parse-worker/test/fixtures.ts`
for the exact path it expects that build output at. `inference-worker`'s
model-fixture tests similarly need `ai-pipeline/quantization/calibration_data/`
generated locally first (gitignored, not part of a fresh clone) — see
`src/workers/inference-worker/scripts/export_reference_fixtures.py`.

The "Load Demo CT" toggle (`src/shell/demoCtControls.ts`) needs real
patient data checked in via **Git LFS**, not a plain blob — two LIDC-IDRI
lung CT series ([`../test-data/lidc_idri/`](../test-data/lidc_idri/README.md))
and one UPENN-GBM brain MR series
([`../test-data/upenn_gbm/`](../test-data/upenn_gbm/README.md)), each
under its own license (CC BY 3.0 / CC BY 4.0 respectively — see each
directory's own README).
If `git lfs` isn't installed on your machine, a normal `git clone`/`git
pull` still succeeds but leaves small text _pointer_ files in those
directories instead of real DICOM data — install it
([git-lfs.com](https://git-lfs.com)) and re-pull (or run `git lfs pull`)
before continuing. Then, same as `sync-engine-wasm` below, copy it into
the Shell's servable path:

```zsh
npm run sync-demo-ct   # copies each collection's demo series into src/shell/public/demo-ct/
```

This script itself checks for the pointer-file case (any source file
under ~10KB) and fails with a `git lfs pull` reminder rather than
silently copying unusable stub data.

### Browser e2e tests (`tests/e2e/`)

Verifies the real Shell against real Workers in a real browser
(Playwright + Chromium) — see `tests/e2e/shell-mask-integration.spec.ts`'s
own doc comment for exactly what each of its 7 tests checks, including
real visual (screenshot-diff) assertions against real DICOM data (issue
number 29), the real UI shell driven end-to-end (issue number 34), the
3D/2D view-mode toggle + slice slider (issue number 37), the responsive
canvas at both desktop and sub-640px mobile viewport widths (issue
number 40), and the file-load progress indicator (issue number 42) —
see "What's not here yet" for what's still deliberately out of scope.
One-time setup, then per-run:

```zsh
# One-time (per machine):
npx playwright install chromium

# Every run, in order:
cd engine && cmake --preset wasm-macos && cmake --build build_wasm   # or wasm-windows
cd ../viewer
npm run sync-engine-wasm   # copies engine/build_wasm/* into src/shell/public/engine/
npm run sync-demo-ct       # copies test-data/lidc_idri/* into src/shell/public/demo-ct/ (needs git-lfs, see above)
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
  `VolumeReadyMessage` — its `width`/`height`/`depth`/`spacingX`/
  `spacingY`/`spacingZ`/`data` fields match
  `rhi::Device::loadVolume`/`engine_load_volume`'s parameters exactly
  (`engine/src/rhi/include/rhi/Device.hpp`, `engine/src/main_wasm.cpp`).
  The optional `windowCenter`/`windowWidth` fields (added 2026-08-27 --
  the series' own DICOM VOI LUT display window, PS3.3 C.11.2, taken from
  the first slice when present) are a Shell-only concern instead --
  main.ts calls `engine_set_window_level` with them directly on load,
  overriding whatever preset/manual value was previously active; they
  never cross into `engine_load_volume`'s own parameter list. Motivation:
  a fixed CT-calibrated preset (e.g. "Brain", center 40/width 80 HU)
  applied to MR data -- which isn't in Hounsfield Units at all -- can
  render as a blown-out white block even though nothing failed to parse;
  the file's own window is the only reliable per-series display hint.

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

- A real, trained segmentation model — the "Load Demo Model" button
  (`inferenceControls.ts`) only points at the repo's dummy, plumbing-only
  ONNX graph (`tests/fixtures/generate-dummy-onnx.py`), which always
  outputs background; a real model is AI-track scope, not shipped here.
  Loading a volume via the file picker with no model loaded is still a
  supported, non-error state — `hu-slice` messages are dropped with a
  console log rather than forwarded, until a model is initialized.
- Mobile touch/pinch input for the camera — mouse-driven controls only
  (issue #34's explicit scope boundary).
- Aspect-ratio-correct letterboxing for the 2D axial slice view when
  voxel spacing is non-square — the raymarch pipeline itself has no
  DPR-correction posture either.
- Anatomical verification of orientation normalization against a real
  multi-slice series with known left/right anatomy — no suitable fixture
  exists yet (see "DICOM orientation normalization" below); only
  synthetic hand-computed cases and the real UPENN-GBM series described
  there are verified so far.
- Sagittal/coronal _reconstruction_ (MPR) is supported for the assembled
  volume (Axial/Sagittal/Coronal/Native view modes), but only the
  whole-series assembly path (`assembleSeries`/`parse-series`) can
  resample a non-axial _acquisition_ onto a canonical grid — the
  single-file streaming path (`parseSliceToHu`/`parse-file`, no
  series-wide context to resample against) still throws
  `UnsupportedOrientationError` for a genuinely oblique/sagittal/coronal
  slice. See "DICOM orientation normalization" below.

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

Scope: two paths exist, and which one handles a given series depends on
whether it's assembled as a whole series or streamed slice-by-slice.

- **Axis-aligned fast path** (`computeOrientationTransform` +
  `applyTransform`): the slice normal (`cross(rowCosine, columnCosine)`)
  must resolve to the patient Z axis, and row/column must be an
  axis-aligned permutation of ±X/±Y (covering realistic HFS/FFS/HFP/FFP
  variation) — handled with a per-slice transpose/flip, no resampling
  needed. Anything else throws `UnsupportedOrientationError`.
- **Oblique-resample fallback** (whole-series assembly only —
  `assembleSeries`/`parse-series`): when the fast path throws, whether
  because row/column aren't axis-aligned _or_ because the slice normal
  isn't Z at all (a genuinely sagittal or coronal acquisition, e.g.
  "T2 SAG SPACE"), `assembleSeries` catches the error and instead
  resamples the _whole series_ onto a canonical-axis-aligned grid via
  trilinear interpolation (`computeObliqueResampleGrid`/
  `canonicalToSourceIndex` in orientation.ts, the resampling loop itself
  in pipeline.ts's `assembleObliqueSeries`). This is normal-agnostic by
  design — `dominantAxisIndex` assigns each _output_ axis's spacing from
  whichever _source_ direction (row/column/normal) actually dominates it,
  rather than assuming the near-axial-tilt case's fixed mapping. Output
  voxel spacing reuses the source's own pixel/slice spacing magnitudes
  unchanged (only re-orienting axes, not rescaling) — a reasonable
  approximation, not a physically-exact resample for arbitrary rotation.
  The single-file streaming path (`parseSliceToHu`/`parse-file`) has no
  series-wide context to resample against, so it still throws
  `UnsupportedOrientationError` for a non-axis-aligned slice regardless
  of which check failed.

Once assembled, the volume can be viewed along any of the three
canonical axes (Axial/Sagittal/Coronal view modes) or as the original
per-file slices, unresampled (Native view mode) — `viewControls.ts` owns
the view-mode toggle and per-mode slice-index memory.

If a slice is missing either tag, its pixel data passes through
unchanged (`console.warn`), and `assembleSeries` falls back to ordering
by `InstanceNumber` instead of true geometric position — see
[`dicom-parser/README.md`](../dicom-parser/README.md#data-model) for
that fallback's own caveats. The result's `orderingMethod` field
(`"geometric"`, `"oblique-resample"`, or `"instanceNumber"`) reports
which path was taken.
