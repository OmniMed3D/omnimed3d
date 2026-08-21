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
import { resolveModelPath } from "./modelSelection.js";
import { runSlice, type MaskSliceMessage } from "./pipeline.js";

interface InitMessage {
  type: "init";
  /**
   * Exact, already-resolved model URL -- used as-is, no hardware-based
   * selection. Kept for callers that need one specific file regardless of
   * hardware (e.g. viewer/tests/e2e/shell-mask-integration.spec.ts's dummy
   * plumbing model, which doesn't care about INT8/FP16 at all). Exactly one
   * of this or `modelBasePath` must be set.
   */
  modelPath?: string;
  /**
   * Base path with no variant suffix or extension (e.g.
   * "/models/lungmask_r231") for hardware-based model selection (Issue
   * #35): this worker detects WebGPU adapter availability itself and picks
   * the FP16 or INT8 variant accordingly -- see modelSelection.ts's
   * resolveModelPath() for why, and the `gpuDetected` field on the
   * `init-complete` ack if a caller wants to show which was picked.
   */
  modelBasePath?: string;
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

// Serializes hu-slice processing so at most one session.run() is ever in
// flight at a time (Issue #35 fallout, found via real browser e2e testing,
// viewer/tests/e2e/shell-mask-integration.spec.ts): the WASM-only EP
// apparently tolerated the previous code's implicit concurrency (each
// incoming hu-slice kicking off its own un-awaited async handler), but the
// WebGPU EP does not -- sending 3 hu-slice messages back-to-back (as the
// real Parse Worker -> Shell -> Inference Worker pipeline does) produced
// zero mask-slice responses at all within 15s, reproduced in isolation
// with a minimal 3-message repro. Chaining onto this promise instead of
// firing runSlice() calls independently forces one-at-a-time execution;
// .catch() keeps one failed slice from poisoning every later one queued
// behind it.
let inferenceQueue: Promise<void> = Promise.resolve();

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;

  if (msg.type === "init") {
    // Cheap capability probe (no session/model involved) -- Issue #35's
    // hardware-based model selection below, and also informs which EP this
    // session will actually prefer (see executionProviders just below).
    const gpuDetected = !!(await navigator.gpu?.requestAdapter());

    const resolvedModelPath = msg.modelBasePath
      ? resolveModelPath(msg.modelBasePath, gpuDetected)
      : msg.modelPath;
    if (!resolvedModelPath) {
      throw new Error("Inference Worker 'init' message needs either modelPath or modelBasePath");
    }

    adapter = new LungmaskAdapter(resolvedModelPath);
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
    session = await ort.InferenceSession.create(resolvedModelPath, options);
    // Callers have no other way to know the (async) session load finished
    // -- without this ack, a caller sending hu-slice right after init()
    // races the load and hits the "received a slice before 'init'" error
    // below (found via real browser e2e testing,
    // viewer/tests/e2e/shell-mask-integration.spec.ts). modelPath/gpuDetected
    // are extra, optional-to-use info for callers that want to show which
    // variant/hardware path actually got picked (see inferenceControls.ts).
    (self as unknown as Worker).postMessage({
      type: "init-complete",
      modelPath: resolvedModelPath,
      gpuDetected,
    });
    return;
  }

  if (msg.type === "hu-slice") {
    const { volumeId, sliceIndex, width, height, data } = msg;
    inferenceQueue = inferenceQueue
      .then(async () => {
        if (!adapter || !session) {
          throw new Error("Inference Worker received a slice before 'init'");
        }
        const result: MaskSliceMessage = await runSlice(adapter, session, {
          volumeId,
          sliceIndex,
          slice: { data: new Float32Array(data), width, height },
        });
        (self as unknown as Worker).postMessage(result, [result.data.buffer]);
      })
      .catch((err: unknown) => {
        console.error("Inference Worker: failed to process hu-slice", volumeId, sliceIndex, err);
      });
  }
};
