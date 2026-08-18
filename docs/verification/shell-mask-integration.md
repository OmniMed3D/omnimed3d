# Shell ↔ Engine Mask Compositor Integration — Verification Report

## Context (for anyone unfamiliar with this project)

This project's browser pipeline has three pieces that used to be
verified only in isolation: a **Parse Worker** (parses a DICOM file into
Hounsfield-Unit pixel data), an **Inference Worker** (runs an AI
segmentation model over that data, producing a per-pixel lung/background
mask), and a C++ rendering **Engine**, compiled to WebAssembly, that
receives both the CT volume and the mask and is meant to display them
together. Nothing previously constructed all three together in a real
browser — each was tested against synthetic or mocked input for its own
piece of the chain.

The **Web Application Shell** is the missing layer that owns this
wiring: it constructs both Workers, listens for their output messages,
and calls into the Engine's WebAssembly exports with the right data at
the right time. This report covers the first real, browser-verified,
end-to-end version of that wiring — not the final production Shell
(there's still no file-picker UI), but the actual message-passing and
Engine integration are real and tested here, not stubbed.

## Test Environment

MacBook, Apple M1, macOS. Chromium 151.0.7922.34 (via Playwright
1.62.1), driven headless. Engine WASM build via the existing
`wasm-macos` CMake preset (Emscripten). `onnxruntime-web` 1.19.x (WASM
backend). All results below are scoped to this environment.

## What was built

- **Real Shell orchestration** (`viewer/src/shell/main.ts`): mints and
  tracks a `volumeId` per loaded volume, routes each Worker's output to
  its correct destination (Parse Worker's per-slice output to the
  Inference Worker; Parse Worker's assembled-volume output and the
  Inference Worker's mask output both into the Engine's WebAssembly
  exports), and discards any mask output whose `volumeId` doesn't match
  the currently-loaded volume.
- **A tiny placeholder AI model** (`viewer/tests/fixtures/dummy-lungmask.onnx`,
  190 bytes): matches the real model's exact input/output tensor
  shapes and names, but does no real computation (it just duplicates its
  input three times). Used only to exercise the Inference Worker's real
  model-loading and inference machinery in a real browser — it says
  nothing about segmentation accuracy, which is out of scope for this
  report (see `docs/verification/inference-worker.md` for that).
- **A real, automated browser test** (`viewer/tests/e2e/shell-mask-integration.spec.ts`,
  Playwright + Chromium): no browser-automation tooling existed in this
  project before this — the one prior "verified with a headless Chrome
  screenshot" claim (for an earlier, narrower smoke test) was a manual,
  one-off step with no reproducible script behind it. This test is
  re-runnable and asserts against the Engine's own real log output
  rather than a human-inspected screenshot.

## What the test verifies

Run against a real DICOM file (a real, de-identified sample CT slice,
not synthetic bytes) and confirmed via the Engine's own C++ log lines
(forwarded to the browser console, not a new verification mechanism
built for this):

1. The Parse Worker parses the real file and produces both a per-slice
   message and an assembled-volume message, both delivered through real
   browser `postMessage`/`Transferable` calls (not plain function
   calls, which is all that had been tested before).
2. The assembled volume successfully loads into the Engine
   (`WebGPUDevice::loadVolume: volumeId=1 128x128x3 loaded`).
3. The Inference Worker loads the placeholder model and produces a real
   mask output via a real `postMessage`/`Transferable` round trip, which
   the Shell successfully forwards into the Engine's mask compositor —
   confirmed for 3 slices from one real parse pass, then 3 more sent
   deliberately **out of order** (slice 3, then 1, then 2) — all 6
   succeed regardless of arrival order
   (`WebGPUDevice::applyMaskSlice: volumeId=1 slice=N applied` × 6, zero
   rejections).
4. **Stale-volume rejection:** after loading a second volume, a mask
   result still carrying the *first* volume's ID is correctly discarded
   by the Shell before it ever reaches the Engine.

**Result: 1/1 passing**, consistently across repeated runs.

**Explicit scope limit:** this only verifies that data moves correctly
through the pipeline and that the Engine's compositor accepts/rejects
calls correctly. It does **not** verify anything about what appears on
screen — the Engine's current rendering code only clears the canvas to a
solid color; there is no pass yet that actually draws the loaded volume
or mask. That's separate, larger, not-yet-started work.

## Bugs found and fixed during implementation

None of these were known beforehand — each was found by actually running
the pipeline in a real browser rather than assuming it would work
because each piece passed its own isolated tests.

**1. Two status displays overwriting each other.** The Shell's own
"ready" message and the WebAssembly runtime's own built-in status
callback were both writing to the same on-page text element, so the
runtime's message (which fires on a timer) intermittently clobbered the
Shell's. Fixed by giving the Shell its own separate status element.

**2. A too-early readiness check crashed the whole WebAssembly module.**
The Shell began polling "is the engine ready?" before the WebAssembly
runtime had finished starting up, which is invalid and — because this
build has runtime assertion-checking enabled — aborted the entire module
outright rather than failing gracefully. Fixed by gating the poll behind
the runtime's own "fully started" callback, matching a pattern an
earlier, unrelated smoke test in this codebase already used correctly
(this test caught a deviation from it, not a new discovery).

**3. Dynamically loading the shared parser module failed silently
inside a Worker.** The Parse Worker loads a separate WebAssembly module
(the DICOM parser) via a dynamic import at runtime. Passing that
module's location as a path relative to the site root worked fine when
tried from the main page, but consistently failed when the exact same
path was used from inside a Worker — Chromium couldn't resolve it in
that context. Using a fully-qualified URL (including the site's own
address, not just the path) instead of a relative one fixed it in both
places.

**4. The dev build server broke the AI runtime's own asset loading.**
The AI inference library (`onnxruntime-web`) needs to load its own
WebAssembly binary at runtime; the local development server's automatic
dependency-optimization step relocated that library's files without
carrying its binary asset along, so the browser ended up being served an
error page in place of the actual binary and failed to parse it. Fixed
by excluding that one library from the dev server's automatic
optimization step. The production build was never affected — it already
bundled the asset correctly.

**5. Both Workers could receive data before they'd finished loading.**
Both the Parse Worker's WebAssembly module and the Inference Worker's AI
model load asynchronously after each Worker reports "initialized." A
caller that starts sending real work immediately after sending the
init request — which is a perfectly reasonable thing to do — can win the
race and hit a "received data before init" error in either Worker.
Fixed by having each Worker explicitly confirm when its own async setup
has actually finished, and having callers (including the Shell) wait for
that confirmation. This is a real race a production Shell could hit
too, not just a test artifact, so the fix lives in both Workers'
production code, not only in the test.

## Known limitations of this verification

- **Headless Chromium needed explicit flags to expose a GPU at all** (no
  GPU adapter was available otherwise) — the flags used are macOS-specific
  (route through Metal); a different host OS would need its own
  equivalent, untested here.
- **The one real DICOM fixture available is a single generic CT slice,
  not a lung scan** — multi-slice/out-of-order testing above reuses that
  same file's bytes under different slice-index labels, which is
  sufficient to test the transport mechanism but says nothing about
  real anatomical content.
- **The placeholder AI model proves the loading/inference machinery
  works, not that any real model's output is correct** — see
  `docs/verification/inference-worker.md` for actual model-accuracy
  results (measured separately, without a real browser).
- No visual/pixel-level check exists or was attempted — see "What the
  test verifies" above.
