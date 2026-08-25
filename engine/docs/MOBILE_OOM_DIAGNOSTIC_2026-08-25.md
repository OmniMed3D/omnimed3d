# Mobile OOM Crash — Real-Device Diagnostic Record

Option A/B/C-3/refined-C-2 (see `RENDERING_SPEC.md`'s Change History)
were all shipped, and the iPhone 14 Pro + Chrome crash still reproduced
identically. This records the full diagnostic process that found the
actual root cause and led to Option D (`RENDERING_SPEC.md`'s
2026-08-25 "unload/reload Engine volume textures during AI inference"
entry) — done entirely on a real device, with no USB connection and no
remote debugger available.

## Why this record matters

- The final cause was something none of A/B/C-3/C-2 touched — this
  explains why shipping all four didn't fix it.
- The diagnostic process directly edited AI-track-owned files
  (`viewer/src/workers/inference-worker/`) multiple times to isolate
  variables. That code turned out not to be at fault; the process itself
  is worth recording so future diagnosis coordinates with the AI track
  up front instead (tracked separately as a retrospective issue).
- The `localStorage` checkpoint technique built for this is a reusable
  pattern for any future "silent crash, no debugger available" situation.

## Symptom

Load CT → click segmentation → model downloads → white screen → the page
silently reloads. No JS exception, no WebGPU device-lost event, and no
iOS crash report/JetsamEvent implicating Chrome at all (the only
JetsamEvent snapshot available that day named an unrelated `assetsd`
daemon as the actual Jetsam victim). Not an OS-level process kill in the
usual sense, and not anything catchable — a genuinely quiet failure.

## Diagnostic tool: `localStorage` checkpoints

With no USB and no remote Web Inspector available, the only way to learn
how far execution got before a crash was to make that state survive the
crash itself.

- At each key step, synchronously write `{label, at}` to `localStorage`
  (`writeCheckpoint`) — this value survives whatever kills the page.
- On the next load, if a checkpoint is still present, show it in a banner
  at the top of the screen (`showLastCheckpointIfAny`) — the last
  surviving checkpoint is exactly "how far did we get."
- Workers can't use `localStorage` directly, so a Worker posts a message
  to the main thread, which writes the checkpoint.
- Clear the checkpoint once a full round trip completes successfully
  (`clearCheckpoint`) — a banner still showing on the next load is itself
  the signal that this run didn't finish.

This tool (`debugCheckpoint.ts` plus `writeCheckpoint(...)` calls
scattered through the relevant files) was fully reverted once Option D
was implemented — it's not part of the shipped code. Reconstructing it
from the description above is straightforward if a similar situation
comes up again.

## Isolating variables, one at a time

Each retest used a fresh full reload (confirmed Vite HMR does not
reload Worker sources — a stale Worker script was ruled out as a
possible confound early on) and changed exactly one variable from the
previous run.

| # | Variable changed | Result | Conclusion |
| --- | --- | --- | --- |
| 1 | Low-memory mode on (Option A, ~266MB gradient-texture savings) | Crash unchanged | Not the sole cause |
| 2 | Forced INT8 quantization (smallest model variant) | Crash unchanged | Model size/precision not the sole cause |
| 3 | Forced WASM-only execution provider (WebGPU excluded from inference entirely) | Crash unchanged, checkpoint pinpointed exactly to `before-session-run` | WebGPU-side inference memory not the cause |
| 4 | Added COOP/COEP headers (`viewer/vite.config.ts`) — not actually a diagnostic probe, a real fix: `onnxruntime-web`'s threaded WASM backend (`ort-wasm-simd-threaded`) silently falls back to single-threaded without cross-origin isolation, and that fallback path itself was not safe on iOS/WebKit | **White-screen crash eliminated.** New symptom: `session.create()` hangs indefinitely after the model reaches 100% downloaded | Found a real, necessary infra fix. New failure mode appeared |
| 5 | Forced `numThreads = 1` (ruling out nested-Worker thread-pool creation as the hang's cause) | Hang replaced by crash again, checkpoint stopped at `worker:inference-started-received` (model load fully succeeds; crash is right after the first real batch begins) | The thread pool was plausibly the hang's cause. Crash point moved later |
| 6 | Split the checkpoint further, inside `runBatch()` (`runBatch-start`/`-preprocessed`/`-tensor-built`) | Stops right after `runBatch-start`, during `adapter.preprocess()` | CPU preprocessing (real 512×512 slices, batch of 8, fully synchronous with no event-loop yield) looked like the leading suspect |
| 7 | `MAX_BATCH_SIZE` 8 → 1 (removes the preprocessing burst) | **Still crashes** — this time preprocessing completes fully, and it crashes at `session.run()` again | The preprocessing burst wasn't the cause either — the crash point simply follows whatever runs last, which is the signature of sitting right at a cumulative memory ceiling, not a specific bug |

Rows 6 and 7 together are the key finding: a crash point that moves
depending on batch size is not a specific bug, it's the signature of a
cumulative memory ceiling with almost no headroom left.

## The decisive test: two real-device confirmations

1. **Skip the Engine's GPU texture upload (`_engine_load_volume`)
   entirely.** Nothing renders (empty canvas), but real segmentation
   completes end to end (`segmentation complete`). No crash.
2. **Same as (1), but retain the volume's raw bytes (~66MB) in the JS
   heap** (`retainedVolumeBytes`) instead of discarding them — i.e. move
   the same byte count off the GPU-resident texture pool into plain JS
   heap rather than eliminating it. **Also no crash.**

(2) is the decisive result. Moving the same number of bytes to a
different process's memory pool was enough to stop the crash. This
matches iOS WebKit's out-of-process GPU architecture: the JetsamEvent
snapshot gathered earlier in this investigation showed `WebKit.GPU`
(pid 18406) and `WebContent` (pid 18403) as separate processes with
separate `rpages` accounting — consistent with them drawing from
meaningfully separate memory budgets.

## Conclusion

- The cause is the Engine's resident GPU volume/gradient/mask textures
  (~100MB even with Option A's low-memory mode) held **concurrently**
  with the Inference Worker's ONNX Runtime session and real activation
  tensors. Neither alone crashes; concurrent residency does.
- Refined C-2 (pause rendering during inference), already shipped,
  reduces GPU **compute** contention but never frees the GPU-**resident**
  textures, so it never touched this problem.
- The actual fix (Option D): release the Engine's GPU textures for the
  duration of an inference run and re-upload them once it finishes. See
  `RENDERING_SPEC.md`'s 2026-08-25 "unload/reload Engine volume textures
  during AI inference" entry for the implementation.

## Lessons for next time

- **Don't edit AI-track-owned code directly for diagnostic probing.**
  This session edited `worker.ts`/`pipeline.ts`/`adapters/lungmask/
  index.ts` multiple times (forced execution provider, forced thread
  count, forced batch size, inserted checkpoint posts) — all reverted,
  confirmed clean via `git diff`, and none of it turned out to matter.
  The process itself repeatedly touched code outside the engine track's
  normal scope. Next time, write up the exact variable to isolate as an
  issue and coordinate with the AI track in one pass instead.
- Vite HMR does not reload Worker sources — confirmed again. A changed
  Worker script needs a full reload/incognito tab, not just HMR.
- A `vite.config.ts` change (e.g. new headers) needs a dev-server
  restart — HMR doesn't pick it up.
- The `localStorage` checkpoint technique is a reusable pattern for a
  future crash investigation with no debugger access.
