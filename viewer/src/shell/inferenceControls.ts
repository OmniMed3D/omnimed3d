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
 * Sends `modelBasePath` (not `modelPath`) so the Inference Worker itself
 * picks INT8 or FP16 based on detected hardware (Issue #35) -- FP16 is
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
 */

const MODEL_BASE_PATH = "/models/lungmask_r231";

export function setupInferenceControls(inferenceWorker: Worker): void {
  const button = document.getElementById("load-demo-model") as HTMLButtonElement | null;
  const status = document.getElementById("demo-model-status");
  if (!button || !status) {
    console.error("inferenceControls: #load-demo-model or #demo-model-status not found in the DOM");
    return;
  }

  // addEventListener rather than overwriting .onmessage -- main.ts already
  // owns inferenceWorker.onmessage for mask-slice/init-complete routing;
  // this listens alongside it without replacing it.
  inferenceWorker.addEventListener(
    "message",
    (event: MessageEvent<{ type: string; gpuDetected?: boolean }>) => {
      if (event.data.type === "init-complete") {
        button.disabled = true;
        button.textContent = "Segmentation model loaded";
        const variant = event.data.gpuDetected ? "FP16, WebGPU" : "INT8, WASM";
        status.textContent = `lungmask R231 (${variant}) active -- real lung segmentation, not a placeholder.`;
      }
    },
  );

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Loading…";
    inferenceWorker.postMessage({ type: "init", modelBasePath: MODEL_BASE_PATH });
  });
}
