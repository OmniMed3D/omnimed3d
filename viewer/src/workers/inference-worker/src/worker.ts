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
import { runBatch, runSlice, type MaskSliceMessage, type SliceRequest } from "./pipeline.js";

// DIAGNOSTIC IN PROGRESS (2026-08-26): numThreads=1 fixed an earlier
// session-creation hang (matching MOBILE_OOM_DIAGNOSTIC_2026-08-25.md row
// 4), but at batch=1 it made each real inference call slow enough (growing
// to 7-10s) that the gap between consecutive "inference-started" events
// exceeded Shell's 750ms reload-debounce -- causing ~25 unload/reload
// cycles across one 133-slice run instead of 1, which also wipes
// previously-applied mask data each time (Engine's unloadVolume() releases
// the mask texture along with the volume/gradient ones). Testing whether
// numThreads=4 is now safe to create a session with: the original hang was
// observed with WebGPU attempted first (["webgpu","wasm"]) under COOP/COEP;
// this session is now created WASM-only from the start (FORCE_WASM_ONLY
// below), a different code path that may not hit the same hang. If session
// creation still hangs, revert to 1 immediately.
ort.env.wasm.numThreads = 4;

/**
 * Fetches a model file's bytes with progress reporting, instead of handing
 * `ort.InferenceSession.create()` a URL and letting it fetch internally --
 * ORT gives no way to observe that internal fetch's progress. `onProgress`
 * receives `total <= 0` when the server didn't send a `Content-Length`
 * (e.g. a dev server response without one), which the caller should treat
 * as "size unknown" rather than a real zero-byte total.
 */
async function fetchModelBytes(url: string, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`model fetch failed: ${url} (${response.status})`);
  }
  const total = Number(response.headers.get("Content-Length") ?? 0);
  if (!response.body) {
    // No streamable body (e.g. a test environment's fetch polyfill) --
    // still correct, just can't report incremental progress.
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, buffer.byteLength);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

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
 *
 * Runs a full `MAX_BATCH_SIZE`-sized batch (not a single slice) through the
 * real `runBatch()` path, deliberately reusing the real code path rather
 * than a hand-rolled shaped tensor -- see MOBILE_OOM_DIAGNOSTIC_2026-08-25.md
 * (`engine/docs/`): the crash it investigated always hit on the *first*
 * real `session.run()` after `init`, regardless of quantization/EP/thread
 * count, and never on later slices in the same session. Untested hypothesis
 * this is meant to probe: WASM linear memory only grows, never shrinks, so
 * whatever one-time `memory.grow()` a session's first batch-sized forward
 * pass needs was previously deferred until the user's actual first
 * inference click -- exactly when the Engine's GPU volume textures are
 * already resident. Forcing that growth here, during `init`, moves it
 * earlier; it may or may not be sufficient on its own (Engine's own
 * `unloadVolume()`-during-inference fix addresses the same window from the
 * other side) but doesn't require any Engine-side coordination to test.
 * `cropAndResize`'s "no body-mask region found" fallback (full-frame bbox)
 * already handles an all-zero input without throwing, confirmed by reading
 * preprocess.ts directly rather than assumed.
 *
 * DIAGNOSTIC IN PROGRESS (2026-08-26): a real-device retest at
 * MAX_BATCH_SIZE (8) crashed on "Load Segmentation Model" alone -- no
 * volume ever loaded, so Engine's GPU textures were never resident. That's
 * a new symptom the original diagnostic never saw (model load always
 * succeeded there), so it's being bisected downward independently of
 * `MAX_BATCH_SIZE` via `VALIDATE_PROBE_BATCH_SIZE` before reconciling the
 * two. Currently at 4 (bisecting down from 8); revert to `MAX_BATCH_SIZE`
 * once a real no-crash/crash boundary is found on the real device.
 */
const VALIDATE_PROBE_BATCH_SIZE = 2;

async function validateSession(candidate: SegmentationAdapter, candidateSession: ort.InferenceSession): Promise<void> {
  const probeSlice: HuSlice = { data: new Float32Array(64 * 64), width: 64, height: 64 };
  const probeRequests: SliceRequest[] = Array.from({ length: VALIDATE_PROBE_BATCH_SIZE }, (_, i) => ({
    volumeId: "__validate-session-probe__",
    sliceIndex: i,
    slice: probeSlice,
  }));
  await runBatch(candidate, candidateSession, probeRequests);
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
// DIAGNOSTIC IN PROGRESS (2026-08-26): batch=8 crashed on the very first
// real production batch. batch=2 got through ~60+ successful batches
// (Engine's unloadVolume/reload cycling correctly each time) before a
// catchable onnxruntime-web WebGPU buffer-download error, whose existing
// per-slice fallback then crashed for real on retry -- pointing at a
// cumulative resource leak across many session.run()+unload/reload cycles
// rather than a single first-call peak. batch=1 tests whether the leak is
// still present per-call (would still eventually fail, just later) or was
// specific to something about pairing 2 slices per call. Revert to 8 once
// resolved.
const MAX_BATCH_SIZE = 1;
const BATCH_WINDOW_MS = 20;

let pendingBatch: SliceRequest[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

// DIAGNOSTIC IN PROGRESS (2026-08-26): real-device logs show
// inference-started/runBatch cycles continuing indefinitely after all
// real hu-slice messages (confirmed exactly 133, matching the volume) have
// been received and flushed -- with no "flushing batch" log preceding
// them, which the current code has no path to produce. Suspect the
// browser console is collapsing visually-identical repeated log lines
// (same sliceIndex, same text) so a real duplicate/re-send isn't visible
// as a duplicate. Monotonic counters on the logs below make every line
// text-distinct so nothing can collapse. Revert once resolved.
let huSliceCounter = 0;
let flushCounter = 0;

function scheduleBatchFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = pendingBatch.splice(0, MAX_BATCH_SIZE);
    if (batch.length > 0) {
      flushCounter += 1;
      const thisFlush = flushCounter;
      console.log(
        "[AI-DIAG] #" + thisFlush + " scheduleBatchFlush: flushing batch",
        batch.map((r) => r.sliceIndex),
      );
      inferenceQueue = inferenceQueue
        .then(async () => {
          // Mobile OOM mitigation: tells the Shell to pause rendering for
          // the duration of this batch, so it doesn't compete with
          // inference for the same GPU. One flush cycle (this .then()
          // body) is the pause/resume unit, not per-slice -- paired with
          // the "inference-ended" post in .finally() below, which fires
          // on both success and failure so a batch error can't leave
          // rendering paused forever. inferenceQueue's own sequential
          // chaining means a back-to-back flush's "inference-started"
          // can't fire until this one's .finally() has already run, so
          // there's no window where rendering incorrectly resumes while
          // a later flush is still actually in flight.
          console.log("[AI-DIAG] #" + thisFlush + " inference-started posted");
          (self as unknown as Worker).postMessage({ type: "inference-started" });
          if (!adapter || !session) {
            throw new Error("Inference Worker received a slice before 'init'");
          }
          let results: MaskSliceMessage[];
          try {
            const runStart = performance.now();
            results = await runBatch(adapter, session, batch);
            console.log("[AI-DIAG] runBatch resolved in", (performance.now() - runStart).toFixed(0), "ms");
          } catch (batchErr) {
            // Some models have a statically-fixed batch=1 input shape
            // rather than a dynamic batch axis (confirmed: the dummy
            // plumbing model viewer/tests/e2e/shell-mask-integration.spec.ts
            // uses, tests/fixtures/generate-dummy-onnx.py, has no
            // dynamic_axes at all, unlike the real lungmask export) --
            // runBatch() throws for those the moment more than one slice
            // needs batching. Found via a real regression in that test,
            // not a hypothetical. Fall back to one-at-a-time processing
            // for this batch (sequential, not Promise.all -- concurrent
            // session.run() calls are exactly what the original
            // concurrency-hang fix above exists to prevent) rather than
            // losing the whole batch silently.
            console.error(
              "Inference Worker: batched inference failed, falling back to per-slice for this batch",
              batch.map((r) => r.sliceIndex),
              batchErr,
            );
            results = [];
            for (const r of batch) {
              results.push(await runSlice(adapter, session, r));
            }
          }
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
        })
        .finally(() => {
          console.log("[AI-DIAG] #" + thisFlush + " inference-ended posted");
          (self as unknown as Worker).postMessage({ type: "inference-ended" });
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
    console.log("[AI-DIAG] init received", { modelPath: msg.modelPath, modelBasePath: msg.modelBasePath });
    // Cheap capability probe (no session/model involved) -- Issue #35's
    // hardware-based model selection below, and also informs which EP this
    // session will actually prefer (see executionProviders just below).
    const gpuDetected = !!(await navigator.gpu?.requestAdapter());
    console.log("[AI-DIAG] gpuDetected =", gpuDetected);

    // DIAGNOSTIC IN PROGRESS (2026-08-26): real-device crash trace pointed
    // at onnxruntime-web's WebGPU buffer manager (buffer_manager.cc,
    // mapAsync failure) -- and batch size alone didn't produce a reliable
    // safe/unsafe boundary (a clean-restart batch=1 run crashed earlier,
    // call #11, than a batch=2 run in an already-warm session). Testing
    // whether avoiding the WebGPU EP entirely (both model selection and
    // execution provider) sidesteps that code path altogether. Leaves
    // `gpuDetected` itself untouched (still accurately reported/logged) --
    // only what gets acted on for model choice and EP list is forced.
    // Revert (drop the `&& false`, restore ["webgpu", "wasm"]) once
    // resolved.
    const FORCE_WASM_ONLY = true;

    const primaryModelPath = msg.modelBasePath
      ? resolveModelPath(msg.modelBasePath, gpuDetected && !FORCE_WASM_ONLY)
      : msg.modelPath;
    if (!primaryModelPath) {
      throw new Error("Inference Worker 'init' message needs either modelPath or modelBasePath");
    }
    console.log("[AI-DIAG] primaryModelPath =", primaryModelPath, "FORCE_WASM_ONLY =", FORCE_WASM_ONLY);

    // WebGPU first, WASM as fallback -- not a replacement (Issue #35). ORT
    // assigns each graph node to the first EP in this list that supports
    // it, falling back to the next one per-node rather than all-or-nothing,
    // so an op WebGPU can't run (e.g. some quantized INT8 ops, see
    // docs/verification/inference-worker.md §8) still runs correctly on
    // WASM instead of failing the whole session.
    const primaryOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: FORCE_WASM_ONLY ? ["wasm"] : ["webgpu", "wasm"],
    };
    if (msg.externalDataPath) {
      const bytes = new Uint8Array(await (await fetch(msg.externalDataPath)).arrayBuffer());
      // The embedded external-data reference inside the ONNX graph is the
      // bare filename (see MODEL_SPEC.md / test/pipeline.test.ts) -- the
      // served file must keep that same name for this to line up.
      const externalDataName = msg.externalDataPath.split("/").pop()!;
      primaryOptions.externalData = [{ path: externalDataName, data: bytes }];
    }

    // Reports download progress as a fraction in [0,1], or null when the
    // server didn't send a Content-Length -- see fetchModelBytes's own
    // comment. A fresh call each time (rather than accumulating across the
    // primary/fallback attempts below) since a fallback re-downloads a
    // different file from scratch, not a continuation of the first one.
    const reportDownloadProgress = (loaded: number, total: number) => {
      (self as unknown as Worker).postMessage({
        type: "init-progress",
        loaded,
        total: total > 0 ? total : null,
      });
    };

    // DIAGNOSTIC IN PROGRESS (2026-08-26): reuses the same init-progress
    // channel inferenceControls.ts (Engine-owned) already renders as
    // "Downloading model... X%" -- no new message type, no Engine-side
    // change needed. Real device testing got stuck at "100%" with no
    // crash, which is ambiguous between "hung inside
    // ort.InferenceSession.create() itself" (matches
    // MOBILE_OOM_DIAGNOSTIC_2026-08-25.md row 4's "session.create() hangs
    // indefinitely after the model reaches 100% downloaded" verbatim, and
    // would have nothing to do with today's batch-size bisection) and
    // "hung inside validateSession()'s probe batch" (would implicate the
    // bisection instead). These two checkpoints disambiguate which one.
    // Remove once resolved.
    const postCheckpoint = (loaded: number) => {
      (self as unknown as Worker).postMessage({ type: "init-progress", loaded, total: 3 });
    };

    let resolvedModelPath = primaryModelPath;
    // FORCE_WASM_ONLY overrides which path actually runs (see above), so
    // the status text needs to reflect that too -- otherwise the Shell
    // shows "FP16, WebGPU" (from the real, unforced gpuDetected) while the
    // session underneath is actually running INT8/WASM, which is exactly
    // backwards for confirming this diagnostic override is in effect.
    let gpuActive = gpuDetected && !FORCE_WASM_ONLY;
    let usedFallback = false;
    try {
      adapter = new LungmaskAdapter(primaryModelPath);
      console.log("[AI-DIAG] fetchModelBytes: starting", primaryModelPath);
      const modelBytes = await fetchModelBytes(primaryModelPath, reportDownloadProgress);
      console.log("[AI-DIAG] fetchModelBytes: done, bytes =", modelBytes.byteLength);
      console.log("[AI-DIAG] InferenceSession.create: starting", primaryOptions);
      const createStart = performance.now();
      session = await ort.InferenceSession.create(modelBytes, primaryOptions);
      console.log("[AI-DIAG] InferenceSession.create: resolved in", (performance.now() - createStart).toFixed(0), "ms");
      postCheckpoint(1); // session.create() resolved
      console.log("[AI-DIAG] validateSession: starting, probe batch =", VALIDATE_PROBE_BATCH_SIZE);
      const validateStart = performance.now();
      await validateSession(adapter, session);
      console.log("[AI-DIAG] validateSession: resolved in", (performance.now() - validateStart).toFixed(0), "ms");
      postCheckpoint(2); // validateSession()'s probe batch resolved
    } catch (err) {
      console.error("[AI-DIAG] init: primary path threw", err);
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
      const fallbackBytes = await fetchModelBytes(resolvedModelPath, reportDownloadProgress);
      console.log("[AI-DIAG] fallback InferenceSession.create: starting (wasm-only)");
      // Force wasm-only for the retry -- webgpu just failed for this
      // session, so there's no reason to let ORT attempt it again here.
      session = await ort.InferenceSession.create(fallbackBytes, { executionProviders: ["wasm"] });
      console.log("[AI-DIAG] fallback InferenceSession.create: resolved");
      // Let this one throw for real if it fails too -- INT8/WASM is the
      // baseline this fallback exists to reach; nothing left below it.
      await validateSession(adapter, session);
      console.log("[AI-DIAG] fallback validateSession: resolved");
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
    console.log("[AI-DIAG] init-complete: sending", { resolvedModelPath, gpuActive, usedFallback });
    (self as unknown as Worker).postMessage({
      type: "init-complete",
      modelPath: resolvedModelPath,
      gpuDetected: gpuActive,
      usedFallback,
    });
    return;
  }

  if (msg.type === "hu-slice") {
    huSliceCounter += 1;
    console.log("[AI-DIAG] #" + huSliceCounter + " hu-slice received", {
      volumeId: msg.volumeId,
      sliceIndex: msg.sliceIndex,
    });
    const { volumeId, sliceIndex, width, height, data } = msg;
    pendingBatch.push({ volumeId, sliceIndex, slice: { data: new Float32Array(data), width, height } });
    scheduleBatchFlush();
  }
};
