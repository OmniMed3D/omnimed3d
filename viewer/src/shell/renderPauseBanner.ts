/**
 * Mobile OOM mitigation (refined C-2): pauses rendering while the
 * Inference Worker is actively running a batch of hu-slice inference,
 * instead of letting rendering and AI inference compete for the same
 * GPU concurrently. Doesn't reduce memory footprint itself (that's
 * Option A/C-3's job) -- removes GPU compute/queue contention between
 * the two workloads, and the transient (staging-buffer-ish) memory
 * pressure rendering itself adds on top of inference's own, specifically
 * during the exact concurrent-load window the original crash happened
 * in.
 *
 * `notifyInferenceStarted()`/`notifyInferenceEnded()` are called from
 * main.ts's inferenceWorker.onmessage handler, driven by
 * "inference-started"/"inference-ended" messages worker.ts posts once
 * per batch-flush cycle (not per slice -- scheduleBatchFlush() can
 * self-reschedule for back-to-back flushes, so one flush cycle is the
 * pause/resume unit).
 */

let paused = false;

export function notifyInferenceStarted(): void {
  if (paused) {
    return; // idempotent -- an overlapping flush cycle shouldn't double-call engine_set_render_paused
  }
  paused = true;
  window.Module._engine_set_render_paused(1);
  const banner = document.getElementById("render-pause-banner");
  if (!banner) {
    console.error("renderPauseBanner: #render-pause-banner not found in the DOM");
    return;
  }
  banner.hidden = false;
}

export function notifyInferenceEnded(): void {
  if (!paused) {
    return;
  }
  paused = false;
  window.Module._engine_set_render_paused(0);
  const banner = document.getElementById("render-pause-banner");
  if (!banner) {
    console.error("renderPauseBanner: #render-pause-banner not found in the DOM");
    return;
  }
  banner.hidden = true;
}
