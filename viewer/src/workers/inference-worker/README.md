# inference-worker

AI segmentation inference (REQ-A03/A09/A16/A17) — the Web Worker that
runs a model adapter's preprocess → infer (ONNX Runtime Web) →
postprocess (REQ-A17: argmax + Nearest-Neighbor-only upscale) over each
Hounsfield-Unit slice the Parse Worker produces, emitting the
`mask-slice` message the Shell routes into the Engine (REQ-C01, PRD
§5.3.2 — see [`../../../README.md`](../../../README.md#message-contracts-between-the-pieces)
for the full routing picture).

This is a `CODEOWNERS` subtree override: the AI track (`@hyuniverse`)
owns this one directory even though the rest of `viewer/` belongs to the
Engine track — see
[`docs/adr/0003-inference-worker-in-viewer.md`](../../../../docs/adr/0003-inference-worker-in-viewer.md)
for why this worker lives inside the `viewer/` npm workspace instead of
its own package under `ai-pipeline/`. Model artifacts themselves (the
`.onnx` files this worker loads) are produced offline by
[`ai-pipeline/`](../../../../ai-pipeline/README.md) — nothing in this
directory trains, converts, or quantizes a model.

## Layout

| Path | What it does |
| --- | --- |
| `src/adapters/types.ts` | The `SegmentationAdapter<TMeta>` protocol every model adapter implements — `preprocess`/`infer`/`postprocess`, with `TMeta` threaded explicitly through the return/parameter values rather than stored as mutable adapter-instance state (`docs/adr/0001-segmentation-adapter-protocol.md`). |
| `src/adapters/lungmask/` | The only adapter today. `preprocess.ts` (HU clip, body-mask crop, resize to 256×256 — a TS port of `lungmask.utils`, matched op-for-op against the Python source), `postprocess.ts` (argmax + Nearest-Neighbor upscale back through the crop bbox — see its doc comment for a real crop-restore bug this fixed), `ndimage.ts` (the small `scipy.ndimage`/`skimage.measure` primitives `preprocess.ts` needs). |
| `src/pipeline.ts` | `runSlice`/`runBatch` — pure, Worker-agnostic orchestration of one adapter through preprocess→infer→postprocess. `runBatch` (`docs/adr/0002-batched-inference-microbatching.md`) stacks several slices into a single `session.run()` call; still emits one `mask-slice` per slice. |
| `src/worker.ts` | The actual `self.onmessage` entry point: model loading (hardware-based INT8/FP16 selection, WebGPU→WASM fallback), the `init`/`hu-slice` message protocol, batch accumulation/flush timing, and WebKit routing (`docs/adr/0003-webkit-routing.md`). |
| `src/environment.ts`, `src/modelSelection.ts` | Pure, unit-testable helper functions `worker.ts` composes: WebKit/iOS detection, and the GPU-vs-hardware model-path/execution-provider decision rules. |
| `docs/adr/` | Design decisions specific to this worker — adapter protocol shape, microbatching, WebKit routing. |
| `scripts/` | Python, own `.venv`/`requirements.txt` — generates the reference/ground-truth fixtures the test suites below diff against, from `ai-pipeline/quantization/calibration_data/selected/`. |
| `bench/`, `e2e/`, `test/` | See "Testing" below. |

## Testing

```sh
cd viewer/src/workers/inference-worker
npm run typecheck
npm test              # vitest, Node — adapter/pipeline unit tests, batch/latency/dice-iou suites
npm run bench          # Node latency benchmark against a real ONNX Runtime session
npm run bench:browser   # Playwright, real browser — see e2e/latency-browser.spec.ts etc.
```

Model-fixture tests (`dice-iou`, `quantized-models`, `latency-benchmark`,
`batch-pipeline`, …) need
`ai-pipeline/quantization/calibration_data/{inference_fixtures,ground_truth_fixtures}/`
populated first. A 5-slice subset is committed via Git LFS so these
suites run in CI (see
[`ai-pipeline/quantization/README.md`](../../../../ai-pipeline/quantization/README.md));
everything beyond that is regenerated locally:

```sh
cd viewer/src/workers/inference-worker
python -m venv .venv && source .venv/bin/activate   # separate venv — own scripts/requirements.txt
pip install -r scripts/requirements.txt
.venv/bin/python scripts/export_reference_fixtures.py
.venv/bin/python scripts/export_ground_truth_masks.py
```

Browser suites (`e2e/`, `npm run bench:browser`) need Playwright's
browser installed once (`npx playwright install chromium`) — see
`playwright.config.ts`.

## Hardware routing (Issue #35 / `docs/adr/0003-webkit-routing.md`)

At `init`, this worker probes `navigator.gpu.requestAdapter()` and the
user agent, then picks one of three paths — the actual rule lives in
`modelSelection.ts`/`environment.ts`, summarized here, not duplicated:

| Environment | Model | Execution providers |
| --- | --- | --- |
| Non-WebKit, WebGPU adapter available | FP16 | `webgpu`, `wasm` fallback |
| Non-WebKit, no WebGPU adapter | INT8 | `wasm` |
| WebKit — iOS (any browser) or desktop macOS Safari | INT8 | `wasm` only, always — the WebGPU/JSEP entry bundle is never even imported (a WebKit JIT bug, not a capability gap; see the ADR) |

A session falls back from FP16/WebGPU to INT8/WASM if session creation or
a real forward pass fails even after a GPU adapter was detected
(`validateSession` in `worker.ts`). A `debugForce` field on the `init`
message (`"wasm-int8" | "gpu-fp16"`, reachable via the Shell's
`?aiForce=` URL param) can force either path for reproduction/regression
testing on hardware that doesn't naturally exercise it — not a
production control.

## What's not here yet

- REQ-A11 full-volume inference as a dedicated entry point — the
  short-window batch accumulation in `worker.ts` (`docs/adr/0002-...md`)
  amortizes per-call overhead across nearby slices, but there's no "run
  this whole volume at once" API.
- A second model adapter / REQ-A14 multi-class segmentation — see
  [`ai-pipeline/README.md`](../../../../ai-pipeline/README.md)'s note on
  the same YAGNI deferral (`organ_taxonomy.json`/`registry.json`).
- Root cause of desktop Safari's ~12-14x WebGPU slowdown — undiagnosed;
  moot for now since WebKit never reaches that code path after
  `docs/adr/0003-webkit-routing.md`, but left open in that ADR's
  "Consequences" in case Safari's WebGPU implementation matures enough to
  revisit.
- The `[AI-DIAG]` console logging in `worker.ts`'s batch-flush path is a
  temporary diagnostic for an in-progress iOS OOM investigation, not
  permanent instrumentation — remove once that investigation closes.

## Documentation

- `docs/adr/` (this directory) — adapter protocol, microbatching, WebKit
  routing.
- [`docs/verification/inference-worker.md`](../../../docs/verification/inference-worker.md)
  — empirical latency/parity measurements the ADRs above cite.
