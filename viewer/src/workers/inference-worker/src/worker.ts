/**
 * Inference Worker entry point (REQ-A03/A09/A16). Thin `self.onmessage`
 * wrapper around pipeline.ts — kept deliberately minimal since browser
 * bundling and the exact Parse Worker -> Inference Worker message shape
 * are not decided yet (REQ-C04 is still mostly open; see
 * ai-pipeline/inference-worker-handoff.md §5).
 *
 * The OUTGOING `mask-slice` shape (§5.3.2) is fixed; the INCOMING shape
 * below is this worker's own provisional assumption for a single HU slice,
 * not a confirmed cross-track contract.
 */
// "onnxruntime-web" (the default subpath) resolves to a bundle that only
// registers the wasm/webgl backends -- the webgpu backend is a separate
// subpath (see package.json's `exports["./webgpu"]`), so it has to be
// imported explicitly to get WebGPU support at all (Issue #35).
import * as ort from "onnxruntime-web/webgpu";
import { LungmaskAdapter } from "./adapters/lungmask/index.js";
import type { SegmentationAdapter } from "./adapters/types.js";
import { runSlice, type MaskSliceMessage } from "./pipeline.js";

interface InitMessage {
  type: "init";
  modelPath: string;
  /**
   * URL/path of the model's external-data companion file (e.g.
   * "lungmask_r231.onnx.data"), for models exported with
   * save_as_external_data=True (currently just the FP32 variant — INT8/FP16
   * are single-file). Omit for single-file models.
   *
   * Without this, `ort.InferenceSession.create()` fails even in a real
   * browser (not just Node) — found via e2e/latency-browser.spec.ts:
   * "Failed to load external data file ..., error: Module.MountedFiles is
   * not available" — ONNX Runtime Web's external-data resolution expects a
   * Node-style mounted file by default and does not fetch a same-directory
   * URL on its own, contrary to what a purely Node-side test (which worked
   * around this with a manual `readFileSync`, see test/pipeline.test.ts)
   * would suggest. Fetching the bytes ourselves and passing them via
   * `externalData` (below) works in both environments.
   */
  externalDataPath?: string;
}

interface HuSliceMessage {
  type: "hu-slice";
  volumeId: string;
  sliceIndex: number;
  width: number;
  height: number;
  data: ArrayBuffer; // float32, row-major, length = width*height
}

type IncomingMessage = InitMessage | HuSliceMessage;

let adapter: SegmentationAdapter | undefined;
let session: ort.InferenceSession | undefined;

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;

  if (msg.type === "init") {
    adapter = new LungmaskAdapter(msg.modelPath);
    // WebGPU first, WASM as fallback -- not a replacement (Issue #35). ORT
    // assigns each graph node to the first EP in this list that supports
    // it, falling back to the next one per-node rather than all-or-nothing,
    // so an op WebGPU can't run (e.g. some quantized INT8 ops, see
    // docs/verification/inference-worker.md §8) still runs correctly on
    // WASM instead of failing the whole session.
    const options: ort.InferenceSession.SessionOptions = { executionProviders: ["webgpu", "wasm"] };
    if (msg.externalDataPath) {
      const bytes = new Uint8Array(await (await fetch(msg.externalDataPath)).arrayBuffer());
      // The embedded external-data reference inside the ONNX graph is the
      // bare filename (see MODEL_SPEC.md / test/pipeline.test.ts) -- the
      // served file must keep that same name for this to line up.
      const externalDataName = msg.externalDataPath.split("/").pop()!;
      options.externalData = [{ path: externalDataName, data: bytes }];
    }
    session = await ort.InferenceSession.create(msg.modelPath, options);
    // Callers have no other way to know the (async) session load finished
    // -- without this ack, a caller sending hu-slice right after init()
    // races the load and hits the "received a slice before 'init'" error
    // below (found via real browser e2e testing,
    // viewer/tests/e2e/shell-mask-integration.spec.ts).
    (self as unknown as Worker).postMessage({ type: "init-complete" });
    return;
  }

  if (msg.type === "hu-slice") {
    if (!adapter || !session) {
      throw new Error("Inference Worker received a slice before 'init'");
    }
    const result: MaskSliceMessage = await runSlice(adapter, session, {
      volumeId: msg.volumeId,
      sliceIndex: msg.sliceIndex,
      slice: { data: new Float32Array(msg.data), width: msg.width, height: msg.height },
    });
    (self as unknown as Worker).postMessage(result, [result.data.buffer]);
  }
};
