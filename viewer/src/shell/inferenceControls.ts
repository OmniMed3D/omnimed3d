/**
 * "Load Segmentation Model" button. Loads the real quantized lungmask
 * R231 model (ai-pipeline/quantization output -- REQ-A02), not the
 * plumbing-only dummy ONNX graph (tests/fixtures/generate-dummy-onnx.py,
 * still used directly by viewer/tests/e2e/shell-mask-integration.spec.ts
 * via omnimed3dTestHooks, bypassing this button entirely -- that test
 * isolates engine-side compositor wiring from model quality on purpose,
 * so it keeps using the dummy model rather than switching to this one).
 * This is what satisfies REQ-A06/§5.3.1's integration criterion, which
 * specifically requires the real 2.5D lung model adapter, not a plumbing
 * stub.
 *
 * The button doubles as a progress gauge (buttonGauge.ts) across two
 * distinct phases that share the same visual real estate: first the
 * model's own byte download (`init-progress` from worker.ts's
 * fetchModelBytes), then -- once the model is ready -- how many of the
 * currently loaded volume's slices have actually been segmented so far
 * (tracked here via notifyVolumeLoadedForInference/notifyMaskSliceApplied,
 * called from main.ts as volume-ready/mask-slice messages arrive). The
 * two phases don't overlap (segmentation can't start before the model is
 * loaded), so one gauge can represent both without ambiguity.
 *
 * Sends `modelBasePath` (not `modelPath`) so the Inference Worker itself
 * picks INT8 or FP16 based on detected hardware -- FP16 is
 * fastest on WebGPU, INT8 is fastest on WASM but the slowest of the three
 * on WebGPU (docs/verification/inference-worker.md §8.4), and neither
 * needs an external-data companion file. This Shell button doesn't need to
 * know which variant got picked, only what the worker reports back on
 * `init-complete` for the status line below.
 *
 * inferenceWorker is passed in rather than imported from main.ts's
 * module scope, matching filePicker.ts's setupFilePicker(loadVolumeFromFiles)
 * pattern of passing the one capability a module needs rather than
 * hoisting more shared state.
 *
 * The button is two-phase, not one-shot: the first click
 * downloads/initializes the model and arms whatever volume is currently
 * loaded ("load the model, it segments what I'm looking at"), but every
 * subsequent new volume load re-enables the button (relabeled "Run
 * Segmentation" via `armedForCurrentVolume`) and requires an explicit
 * click (which just arms the new volume -- no re-download) before that
 * volume's hu-slices are forwarded to the Inference Worker. This keeps a
 * newly loaded file from silently triggering a slow (and, in Low-Memory
 * Mode, render-pausing) inference pass. The actual forwarding gate lives
 * in main.ts (segmentationArmedVolumeId) -- `armSegmentationForCurrentVolume`
 * is what flips it.
 */

import { setGaugeLabel, setGaugeProgress } from "./buttonGauge.js";
import { shouldUseLowMemoryMode } from "./deviceTier.js";

const MODEL_BASE_PATH = "/models/lungmask_r231";

/**
 * Debug-only override (?aiForce=wasm-int8 or ?aiForce=gpu-fp16 on the
 * URL), same pattern as deviceTier.ts's ?lowMemory=<0|1> -- lets a tester
 * reproduce either inference path without needing hardware that actually
 * exercises it (e.g. simulating the iOS/WebKit WASM-only workaround on a
 * desktop with a working WebGPU adapter, so the mask/reload-debounce work
 * can be checked against it without a real iPhone). Not a production
 * control -- no UI affordance for it, URL param only. See worker.ts's
 * InitMessage.debugForce for what each value forces.
 */
function debugForceFromUrl(): "wasm-int8" | "gpu-fp16" | undefined {
  const value = new URLSearchParams(location.search).get("aiForce");
  return value === "wasm-int8" || value === "gpu-fp16" ? value : undefined;
}

let gaugeButton: HTMLButtonElement | null = null;
let modelLoaded = false;

// Whether the *currently loaded* volume has been armed for segmentation
// (see this module's header comment) -- distinct from modelLoaded, which
// only tracks whether the model itself is ready. Starts false even after
// the model first loads; the init-complete handler below sets it true
// immediately (auto-arming whatever volume is current at that moment),
// and notifyVolumeLoadedForInference resets it false on every subsequent
// new volume.
let armedForCurrentVolume = false;

// Per-volume segmentation progress. Reset on every new volume load
// (notifyVolumeLoadedForInference), independent of whether the model has
// finished loading yet -- the total is known as soon as a volume is,
// whichever order the two loads happen in; mask-slice messages simply
// can't arrive until both are ready.
let progressVolumeId: string | null = null;
let progressTotal = 0;
let progressCompleted = 0;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderGauge(): void {
  if (!gaugeButton || !modelLoaded) {
    // Still in the download phase (or no button found) -- the
    // init-progress handler below drives the gauge directly during that
    // phase, so there's nothing for this function to render yet.
    return;
  }
  if (!armedForCurrentVolume) {
    // A new volume loaded after the model was already active, or the
    // model just finished loading but no volume exists yet to arm -- see
    // this module's header comment for why this no longer auto-runs.
    setGaugeLabel(gaugeButton, "Run Segmentation");
    setGaugeProgress(gaugeButton, 0);
    return;
  }
  if (progressTotal <= 0) {
    setGaugeLabel(gaugeButton, "Segmentation model loaded");
    setGaugeProgress(gaugeButton, 1);
    return;
  }
  if (progressCompleted >= progressTotal) {
    setGaugeLabel(gaugeButton, "Segmentation complete");
    setGaugeProgress(gaugeButton, 1);
    return;
  }
  setGaugeLabel(gaugeButton, `Segmenting... (${progressCompleted}/${progressTotal})`);
  setGaugeProgress(gaugeButton, progressCompleted / progressTotal);
}

/** Call when a new volume finishes loading (main.ts's engineLoadVolume). */
export function notifyVolumeLoadedForInference(volumeId: string, totalSlices: number): void {
  progressVolumeId = volumeId;
  progressTotal = totalSlices;
  progressCompleted = 0;
  if (modelLoaded) {
    // A new volume never auto-arms just because the model is already
    // active -- re-enable the button so the user can explicitly request
    // it for *this* volume instead.
    armedForCurrentVolume = false;
    if (gaugeButton) {
      gaugeButton.disabled = false;
    }
  }
  renderGauge();
}

/** Call for every applied mask-slice (main.ts's engineApplyMaskSlice). */
export function notifyMaskSliceApplied(volumeId: string): void {
  if (volumeId !== progressVolumeId) {
    return;
  }
  progressCompleted += 1;
  renderGauge();
}

export function setupInferenceControls(inferenceWorker: Worker, armSegmentationForCurrentVolume: () => void): void {
  const button = document.getElementById("load-demo-model") as HTMLButtonElement | null;
  const status = document.getElementById("demo-model-status");
  if (!button || !status) {
    console.error("inferenceControls: #load-demo-model or #demo-model-status not found in the DOM");
    return;
  }
  gaugeButton = button;

  // addEventListener rather than overwriting .onmessage -- main.ts already
  // owns inferenceWorker.onmessage for mask-slice/init-complete routing;
  // this listens alongside it without replacing it.
  inferenceWorker.addEventListener(
    "message",
    (
      event: MessageEvent<{
        type: string;
        loaded?: number;
        total?: number | null;
        gpuDetected?: boolean;
        usedFallback?: boolean;
        debugForce?: "wasm-int8" | "gpu-fp16" | null;
      }>,
    ) => {
      if (event.data.type === "init-progress") {
        const loaded = event.data.loaded ?? 0;
        const total = event.data.total;
        if (total === null || total === undefined) {
          setGaugeProgress(button, null);
          setGaugeLabel(button, `Downloading model... (${formatBytes(loaded)})`);
        } else {
          setGaugeProgress(button, loaded / total);
          setGaugeLabel(button, `Downloading model... ${Math.round((loaded / total) * 100)}%`);
        }
        return;
      }
      if (event.data.type === "init-complete") {
        modelLoaded = true;
        // Auto-arms whatever volume is current right now -- matches the
        // previously-expected "load the model, it segments what I'm
        // looking at" first-time flow (see this module's header comment).
        // A *subsequent* new volume load resets armedForCurrentVolume via
        // notifyVolumeLoadedForInference instead of re-running this.
        armedForCurrentVolume = true;
        armSegmentationForCurrentVolume();
        button.disabled = true;
        const variant = event.data.gpuDetected ? "FP16, WebGPU" : "INT8, WASM";
        // usedFallback (recover-from-WebGPU-failure issue) means gpuDetected
        // is false despite a GPU adapter actually being found -- worth
        // saying so explicitly, since otherwise this looks identical to "no
        // GPU was ever available" even though something failed underneath.
        const note = event.data.usedFallback ? " (WebGPU failed, fell back automatically)" : "";
        const debugNote = event.data.debugForce ? ` [debug-forced: ${event.data.debugForce}]` : "";
        status.textContent = `lungmask R231 (${variant}) active${note}${debugNote} -- real lung segmentation, not a placeholder.`;
        renderGauge();
      }
    },
  );

  button.addEventListener("click", () => {
    if (modelLoaded) {
      // The model's already loaded (this is a re-enabled "Run
      // Segmentation" click for a volume that loaded after it) -- just
      // arm this volume, no re-download/re-init needed.
      armedForCurrentVolume = true;
      button.disabled = true;
      armSegmentationForCurrentVolume();
      renderGauge();
      return;
    }
    button.disabled = true;
    setGaugeLabel(button, "Downloading model...");
    setGaugeProgress(button, 0);
    // Low-Memory Mode pauses rendering for the duration of each inference
    // batch (renderPauseBanner.ts) and runs against downsampled textures
    // -- the combination reads as "stuck" without this heads-up.
    // Overwritten by the init-complete handler below once the model
    // finishes loading.
    if (shouldUseLowMemoryMode()) {
      status.textContent =
        "Low-Memory Mode is on -- segmentation may take longer than usual, since rendering pauses while each batch runs.";
    }
    const debugForce = debugForceFromUrl();
    inferenceWorker.postMessage({
      type: "init",
      modelBasePath: MODEL_BASE_PATH,
      ...(debugForce ? { debugForce } : {}),
    });
  });
}
