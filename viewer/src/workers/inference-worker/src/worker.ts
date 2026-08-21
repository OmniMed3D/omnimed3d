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
import type { HuSlice, SegmentationAdapter } from "./adapters/types.js";
import { resolveModelPath } from "./modelSelection.js";
import { runBatch, type SliceRequest } from "./pipeline.js";

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

/**
 * Confirms a session can actually run a forward pass, not just that
 * `ort.InferenceSession.create()` resolved (issue: "Recover from WebGPU
 * session/inference failure after hardware detection succeeds" --
 * `navigator.gpu.requestAdapter()` succeeding, per Issue #35's
 * `gpuDetected` probe, doesn't guarantee `session.run()` itself works --
 * a Dawn/driver quirk could still make the first real inference fail).
 * Runs the adapter's own preprocess()/infer() on a throwaway all-zero
 * slice -- deliberately reuses the real code path (not a hand-rolled
 * shaped tensor) so this stays adapter-agnostic; `cropAndResize`'s
 * "no body-mask region found" fallback (full-frame bbox) already handles
 * an all-zero input without throwing, confirmed by reading
 * preprocess.ts directly rather than assumed.
 */
async function validateSession(candidate: SegmentationAdapter, candidateSession: ort.InferenceSession): Promise<void> {
  const probeSlice: HuSlice = { data: new Float32Array(64 * 64), width: 64, height: 64 };
  const { tensor } = candidate.preprocess(probeSlice);
  await candidate.infer(candidateSession, tensor);
}

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

// Batch accumulation strategy (Issue #24): incoming hu-slice messages are
// buffered for a short window instead of triggering inference immediately,
// so a burst of slices arriving close together (e.g. the Parse Worker
// forwarding many slices from one DICOM series) gets combined into fewer,
// larger session.run() calls -- see pipeline.ts's runBatch() for why that
// reduces total processing time.
//
// "Wait for exactly MAX_BATCH_SIZE slices" was rejected: a volume's slice
// count isn't guaranteed to be a multiple of any fixed batch size, so a
// trailing remainder would either stall forever waiting for slices that
// will never come, or need separate end-of-volume signaling this worker
// doesn't currently have. A pure microtask-level flush (queueMicrotask)
// was also rejected: that fires before the event loop delivers additional
// already-queued postMessage events, so it would never actually see more
// than one slice per flush -- defeating the point. A short macrotask-level
// window (setTimeout) lets several already-in-flight messages arrive
// before flushing, and a lone slice (no burst) still only waits one short
// window, not indefinitely.
//
// MAX_BATCH_SIZE=8 chosen from measurement (test/batch-latency-benchmark.test.ts,
// e2e/batch-latency-browser.spec.ts; see docs/verification/inference-worker.md
// §10), not guessed -- most model/EP combinations plateau by batch size
// 4-8 (modest ~10-20% gain), but INT8-on-WebGPU keeps improving through 8
// (1.60x at 8, still climbing) and is the one combination where this
// matters most: batching amortizes the fixed per-call cost of its 117
// CPU-fallback QuantizeLinear nodes (§8.3) across the whole batch instead
// of paying it per slice, which is enough to bring INT8-on-WebGPU under
// the 500ms/slice target for the first time (was the one model/EP gap
// Issue #35 left open).
const MAX_BATCH_SIZE = 8;
const BATCH_WINDOW_MS = 20;

let pendingBatch: SliceRequest[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleBatchFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = pendingBatch.splice(0, MAX_BATCH_SIZE);
    if (batch.length > 0) {
      inferenceQueue = inferenceQueue
        .then(async () => {
          if (!adapter || !session) {
            throw new Error("Inference Worker received a slice before 'init'");
          }
          const results = await runBatch(adapter, session, batch);
          for (const result of results) {
            (self as unknown as Worker).postMessage(result, [result.data.buffer]);
          }
        })
        .catch((err: unknown) => {
          console.error(
            "Inference Worker: failed to process batch",
            batch.map((r) => r.sliceIndex),
            err,
          );
        });
    }
    // More accumulated during this window than MAX_BATCH_SIZE (or arrived
    // while the batch above was still being scheduled) -- flush again
    // rather than waiting for a fresh hu-slice message to trigger it.
    if (pendingBatch.length > 0) scheduleBatchFlush();
  }, BATCH_WINDOW_MS);
}

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;

  if (msg.type === "init") {
    // Cheap capability probe (no session/model involved) -- Issue #35's
    // hardware-based model selection below, and also informs which EP this
    // session will actually prefer (see executionProviders just below).
    const gpuDetected = !!(await navigator.gpu?.requestAdapter());

    const primaryModelPath = msg.modelBasePath
      ? resolveModelPath(msg.modelBasePath, gpuDetected)
      : msg.modelPath;
    if (!primaryModelPath) {
      throw new Error("Inference Worker 'init' message needs either modelPath or modelBasePath");
    }

    // WebGPU first, WASM as fallback -- not a replacement (Issue #35). ORT
    // assigns each graph node to the first EP in this list that supports
    // it, falling back to the next one per-node rather than all-or-nothing,
    // so an op WebGPU can't run (e.g. some quantized INT8 ops, see
    // docs/verification/inference-worker.md §8) still runs correctly on
    // WASM instead of failing the whole session.
    const primaryOptions: ort.InferenceSession.SessionOptions = { executionProviders: ["webgpu", "wasm"] };
    if (msg.externalDataPath) {
      const bytes = new Uint8Array(await (await fetch(msg.externalDataPath)).arrayBuffer());
      // The embedded external-data reference inside the ONNX graph is the
      // bare filename (see MODEL_SPEC.md / test/pipeline.test.ts) -- the
      // served file must keep that same name for this to line up.
      const externalDataName = msg.externalDataPath.split("/").pop()!;
      primaryOptions.externalData = [{ path: externalDataName, data: bytes }];
    }

    let resolvedModelPath = primaryModelPath;
    let gpuActive = gpuDetected;
    let usedFallback = false;
    try {
      adapter = new LungmaskAdapter(primaryModelPath);
      session = await ort.InferenceSession.create(primaryModelPath, primaryOptions);
      await validateSession(adapter, session);
    } catch (err) {
      // Only a modelBasePath (hardware-auto-selected) caller run against a
      // detected GPU has a fallback target worth retrying with -- an
      // explicit modelPath caller (e.g. shell-mask-integration.spec.ts's
      // dummy plumbing model) asked for one exact file and has nothing
      // else to fall back to, and a caller that already got gpuDetected
      // false is already on the INT8/WASM baseline this fallback exists to
      // reach, so there's nowhere further to fall back to either.
      if (!msg.modelBasePath || !gpuDetected) {
        throw err;
      }
      console.error(
        "Inference Worker: primary session (gpuDetected=true) failed, falling back to INT8/WASM",
        err,
      );
      usedFallback = true;
      gpuActive = false;
      resolvedModelPath = resolveModelPath(msg.modelBasePath, false);
      adapter = new LungmaskAdapter(resolvedModelPath);
      // Force wasm-only for the retry -- webgpu just failed for this
      // session, so there's no reason to let ORT attempt it again here.
      session = await ort.InferenceSession.create(resolvedModelPath, { executionProviders: ["wasm"] });
      // Let this one throw for real if it fails too -- INT8/WASM is the
      // baseline this fallback exists to reach; nothing left below it.
      await validateSession(adapter, session);
    }

    // Callers have no other way to know the (async) session load finished
    // -- without this ack, a caller sending hu-slice right after init()
    // races the load and hits the "received a slice before 'init'" error
    // below (found via real browser e2e testing,
    // viewer/tests/e2e/shell-mask-integration.spec.ts). modelPath/gpuDetected
    // are extra, optional-to-use info for callers that want to show which
    // variant/hardware path actually got picked (see inferenceControls.ts).
    // gpuDetected reflects the *active* path (false after a fallback, even
    // though a GPU adapter really was detected) since that's what actually
    // determines which model is running; usedFallback distinguishes that
    // case from "no GPU was ever detected" for anything that wants to
    // surface the difference.
    (self as unknown as Worker).postMessage({
      type: "init-complete",
      modelPath: resolvedModelPath,
      gpuDetected: gpuActive,
      usedFallback,
    });
    return;
  }

  if (msg.type === "hu-slice") {
    const { volumeId, sliceIndex, width, height, data } = msg;
    pendingBatch.push({ volumeId, sliceIndex, slice: { data: new Float32Array(data), width, height } });
    scheduleBatchFlush();
  }
};
