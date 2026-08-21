/**
 * "Load Segmentation Model" button. Loads the real quantized lungmask
 * R231 model (INT8, ai-pipeline/quantization output -- REQ-A02), not the
 * plumbing-only dummy ONNX graph (tests/fixtures/generate-dummy-onnx.py,
 * still used directly by viewer/tests/e2e/shell-mask-integration.spec.ts
 * via omnimed3dTestHooks, bypassing this button entirely -- that test
 * isolates engine-side compositor wiring from model quality on purpose,
 * so it keeps using the dummy model rather than switching to this one).
 * This is what satisfies REQ-A06/§5.3.1's integration criterion, which
 * specifically requires the real 2.5D lung model adapter, not a plumbing
 * stub.
 *
 * INT8 chosen over FP32/FP16: no external-data companion file to wire up
 * (see inference-worker/src/worker.ts's InitMessage.externalDataPath),
 * and it's the fastest of the three in every latency measurement so far
 * (see docs/verification/inference-worker.md).
 *
 * inferenceWorker is passed in rather than imported from main.ts's
 * module scope, matching filePicker.ts's setupFilePicker(loadVolumeFromFiles)
 * pattern of passing the one capability a module needs rather than
 * hoisting more shared state.
 */

const MODEL_PATH = "/models/lungmask_r231_int8.onnx";

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
  inferenceWorker.addEventListener("message", (event: MessageEvent<{ type: string }>) => {
    if (event.data.type === "init-complete") {
      button.disabled = true;
      button.textContent = "Segmentation model loaded";
      status.textContent = "lungmask R231 (INT8) active -- real lung segmentation, not a placeholder.";
    }
  });

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Loading…";
    inferenceWorker.postMessage({ type: "init", modelPath: MODEL_PATH });
  });
}
