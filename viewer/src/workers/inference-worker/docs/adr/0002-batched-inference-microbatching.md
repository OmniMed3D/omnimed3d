# ADR-0002: Timeout-windowed microbatching for `hu-slice` processing

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-21 |

## Context

PRD §4's AI Inference Latency budget is <500ms/slice. Issue #35's
measurement (`docs/verification/inference-worker.md` §8.4) found every
model/EP combination except one already met that target calling
`session.run()` once per slice — INT8-on-WebGPU was the outlier, slowest
of the three on WebGPU (its 117 `QuantizeLinear` nodes fall back to WASM
per-node every call, §8.3) and the one gap left open. Batching multiple
slices into a single `session.run()` call amortizes that per-call
overhead across the batch instead of paying it per slice, and REQ-A11
(multi-slice/full-volume inference) already anticipated this as a
roadmapped need independent of that specific gap.

## Decision

- `pipeline.ts` gains `runBatch(adapter, session, requests)`, reusing
  `preprocess()`/`infer()`/`postprocess()` from `SegmentationAdapter`
  (ADR-0001) completely unchanged — `preprocess()`/`postprocess()` still
  run once per slice, only the single `infer()` call in the middle
  operates on a stacked `[N, ...]` batch tensor. No new adapter methods.
- `worker.ts` accumulates incoming `hu-slice` messages in `pendingBatch`
  and flushes on a macrotask-level `setTimeout(fn, BATCH_WINDOW_MS)`
  timer (`BATCH_WINDOW_MS = 20`), not immediately per message and not on
  a microtask.
- `MAX_BATCH_SIZE = 8`, chosen from measurement
  (`test/batch-latency-benchmark.test.ts`, `e2e/batch-latency-browser.spec.ts`,
  `docs/verification/inference-worker.md` §10), not guessed: most
  model/EP combinations plateau by batch size 4-8 (~10-20% gain), but
  INT8-on-WebGPU keeps improving through 8 (1.60x, still climbing) and is
  the one combination this exists to fix — batching amortizes its 117
  CPU-fallback nodes' fixed per-call cost across the whole batch, bringing
  it under the 500ms/slice target for the first time.
- If a batched `session.run()` throws (a model whose ONNX graph has a
  statically-fixed batch=1 input shape rather than a dynamic batch axis —
  confirmed real case: `tests/fixtures/generate-dummy-onnx.py`'s plumbing
  model has no `dynamic_axes` at all, unlike the real Lungmask export),
  `worker.ts` catches it and falls back to sequential per-slice
  `runSlice()` calls for that batch — sequential, not `Promise.all`,
  since concurrent `session.run()` calls is exactly what the
  serialization fix (`inferenceQueue`) exists to prevent.

## Consequences

- `mask-slice` messages are still emitted one per input slice, in the
  same shape as before batching existed — PRD §5.3.2's progressive
  delivery contract is unaffected; batching is invisible outside this
  file and `worker.ts`.
- A volume's slice count need not be a multiple of `MAX_BATCH_SIZE` — a
  trailing remainder simply flushes as a smaller batch after one
  `BATCH_WINDOW_MS` window, never stalls waiting for slices that won't
  arrive.
- Any future adapter/model with a statically-fixed batch shape degrades
  gracefully to per-slice processing rather than losing the batch's
  slices outright — this fallback exists because that exact failure mode
  was hit as a real regression against the dummy plumbing model after
  this feature first shipped (`e2e/worker-batch-static-shape-fallback.spec.ts`
  guards it).
- Real ONNX exports (FP32/INT8/FP16) must keep a dynamic batch axis for
  this to have any effect; this was verified directly against the `.onnx`
  files for this project's three variants, not just their export scripts,
  before this was built.

## Alternatives Considered

- **Wait for exactly `MAX_BATCH_SIZE` slices before flushing.** Rejected —
  a volume's slice count isn't guaranteed to be a multiple of any fixed
  batch size, so a trailing remainder would either stall forever waiting
  for slices that will never come, or need separate end-of-volume
  signaling this worker doesn't have.
- **`queueMicrotask`-based flush.** Rejected — a microtask callback runs
  before the event loop delivers additional already-queued `postMessage`
  events, so it would never actually see more than one slice per flush in
  practice (each arrives as its own macrotask), defeating the point of
  batching at all.
- **Batch size 16/32.** Measured (Node/WASM benchmark) but not adopted:
  batch=32 took over 10 minutes in that benchmark and was abandoned as a
  timeout risk before a real number could even be produced — WASM compute
  here is compute-bound, not overhead-bound, so larger batches scale
  roughly linearly in cost rather than continuing to amortize a fixed
  cost. `MAX_BATCH_SIZE=8` captures the combination (INT8-on-WebGPU) that
  benefits most without paying that scaling cost for the rest.
