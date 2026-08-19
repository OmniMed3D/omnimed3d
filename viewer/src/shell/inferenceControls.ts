/**
 * "Load Demo Model" button (visual polish follow-up) -- the only model
 * in this repo is a tiny, plumbing-only dummy ONNX graph
 * (tests/fixtures/generate-dummy-onnx.py) that always outputs
 * background; a real trained model is AI-track scope, not shipped here.
 * This wires the previously test-hooks-only Inference Worker init path
 * (window.omnimed3dTestHooks.inferenceWorker) into the real UI so the
 * pipeline (Worker init -> hu-slice -> mask-slice -> compositor) is
 * exercisable and visible without pretending the output means anything
 * clinically -- both the button and the status text stay explicit about
 * "Demo Model".
 *
 * inferenceWorker is passed in rather than imported from main.ts's
 * module scope, matching filePicker.ts's setupFilePicker(loadVolumeFromFiles)
 * pattern of passing the one capability a module needs rather than
 * hoisting more shared state.
 */

const DEMO_MODEL_PATH = "/models/dummy-lungmask.onnx";

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
      button.textContent = "Demo model loaded";
      status.textContent = "Demo model active -- always outputs background, not real segmentation.";
    }
  });

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Loading…";
    inferenceWorker.postMessage({ type: "init", modelPath: DEMO_MODEL_PATH });
  });
}
