/**
 * Inference Worker entry point (REQ-A03/A09/A16). Thin `self.onmessage`
 * wrapper around pipeline.ts.
 *
 * The OUTGOING `mask-slice` shape (§5.3.2) is fixed; the INCOMING shape
 * below is this worker's own provisional assumption for a single HU slice,
 * not a PRD-confirmed cross-track contract (REQ-C04).
 */
// Type-only -- "onnxruntime-web" and "onnxruntime-web/webgpu" are the same
// package's two entry bundles and export identical types, so this covers
// both without committing to either at compile time. Which one actually
// loads at runtime is decided per `init` message (dynamic `import()`, not
// this), since it depends on isWebKitForced()/gpuDetected -- only known
// once a message arrives. The default "onnxruntime-web" subpath only
// registers the wasm/webgl backends; the webgpu (JSEP) backend is a
// separate subpath (see package.json's `exports["./webgpu"]`) -- but
// merely loading that JSEP-variant WASM binary carries the WebKit JIT bug
// (microsoft/onnxruntime#26827) regardless of whether WebGPU ends up used,
// so a WebKit session must never import it, full stop (see environment.ts).
import type * as ort from "onnxruntime-web";
import { LungmaskAdapter } from "./adapters/lungmask/index.js";
import type { HuSlice, SegmentationAdapter } from "./adapters/types.js";
import { isIOS, isWebKitForced } from "./environment.js";
import { resolveEffectiveGpuDetected, resolveModelPath, type DebugForce } from "./modelSelection.js";
import { runBatch, runSlice, type MaskSliceMessage, type SliceRequest } from "./pipeline.js";

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
  /**
   * Debug-only override: forces this session onto one specific inference
   * path regardless of what `navigator.gpu` actually reports. Not a
   * production control -- for reproducing either path on hardware that
   * doesn't naturally exercise it (e.g. simulating the iOS/WebKit
   * WASM-only workaround on a desktop with a working GPU, so the Engine
   * track can debug against it without a real iPhone). Intended source:
   * Shell reading a `?aiForce=wasm-int8|gpu-fp16` URL param and passing
   * it straight through on `init` -- that Shell-side wiring is not part
   * of this change, so for now this is reachable via a direct
   * `postMessage` (e.g. bench/workerHarness.ts) until the Shell change
   * lands.
   * - "wasm-int8": INT8 model, `executionProviders: ["wasm"]` only --
   *   WebGPU is never attempted, even if an adapter is available.
   * - "gpu-fp16": FP16 model, `executionProviders: ["webgpu", "wasm"]` --
   *   attempted even if no adapter is available (session creation will
   *   fail and fall through to the existing INT8/WASM fallback below,
   *   same as an unforced session would).
   */
  debugForce?: DebugForce;
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
 * `ort.InferenceSession.create()` resolved -- `navigator.gpu.requestAdapter()`
 * succeeding doesn't guarantee `session.run()` itself works, since a
 * Dawn/driver quirk could still make the first real inference fail. Runs
 * the adapter's own preprocess()/infer() on a throwaway all-zero slice --
 * deliberately reuses the real code path (not a hand-rolled shaped tensor)
 * so this stays adapter-agnostic; `cropAndResize`'s "no body-mask region
 * found" fallback already handles an all-zero input without throwing.
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

// Incoming hu-slice messages are buffered for a short window (setTimeout,
// not queueMicrotask -- a microtask-level flush fires before the event loop
// delivers additional already-queued postMessage events, so it would never
// see more than one slice per flush) and combined into fewer, larger
// session.run() calls -- see pipeline.ts's runBatch() for why that reduces
// total processing time.
//
// MAX_BATCH_SIZE differs by platform, from measurement rather than a guess
// (test/batch-latency-benchmark.test.ts, e2e/batch-latency-browser.spec.ts;
// see docs/verification/inference-worker.md §10): most model/EP
// combinations plateau by batch size 4-8, but INT8-on-WebGPU keeps
// improving through 8 and needs that size to bring its per-call
// CPU-fallback overhead (§8.3) under the 500ms/slice target. iOS gets 4
// instead -- 8 reliably crashes on real hardware, while desktop Safari
// stays stable at 8, which is why this checks isIOS() specifically rather
// than isWebKitForced() (see environment.ts's isIOS() comment).
const MAX_BATCH_SIZE = isIOS(navigator.userAgent) ? 4 : 8;
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
          // Mobile OOM mitigation: tells the Shell to pause rendering for the
          // duration of this batch (per flush, not per-slice) so it doesn't
          // compete with inference for the same GPU -- paired with the
          // "inference-ended" post in .finally() below, which fires on both
          // success and failure so a batch error can't leave rendering
          // paused forever.
          (self as unknown as Worker).postMessage({ type: "inference-started" });
          if (!adapter || !session) {
            throw new Error("Inference Worker received a slice before 'init'");
          }
          let results: MaskSliceMessage[];
          try {
            results = await runBatch(adapter, session, batch);
          } catch (batchErr) {
            // Some models have a statically-fixed batch=1 input shape rather
            // than a dynamic batch axis (e.g. tests/fixtures/generate-dummy-onnx.py's
            // dummy plumbing model), for which runBatch() throws the moment
            // more than one slice needs batching. Fall back to one-at-a-time
            // processing for this batch (sequential, not Promise.all --
            // concurrent session.run() calls are what the concurrency-hang
            // fix above exists to prevent) rather than losing the whole
            // batch silently.
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
    // Cheap capability probe (no session/model involved) -- Issue #35's
    // hardware-based model selection below, and also informs which EP this
    // session will actually prefer (see executionProviders just below).
    const gpuDetected = !!(await navigator.gpu?.requestAdapter());
    // WebKit (iOS, any browser; or desktop macOS Safari) never gets a
    // WebGPU session regardless of gpuDetected -- see environment.ts and
    // resolveEffectiveGpuDetected's own comment for why this isn't a
    // capability check.
    const webKitForced = isWebKitForced(navigator.userAgent);
    // See InitMessage.debugForce -- replaces the real probe result outright
    // when set, for both model selection just below and the EP list right
    // after it.
    const effectiveGpuDetected = resolveEffectiveGpuDetected(msg.debugForce, gpuDetected, webKitForced);
    // Which entry bundle loads is decided here, once, from the same
    // effectiveGpuDetected value everything else below uses -- never the
    // JSEP ("/webgpu") bundle for a WebKit session, full stop (see the
    // import comment at the top of this file). The fallback-from-WebGPU-
    // failure retry further down reuses this same module rather than
    // re-importing: it only ever runs when effectiveGpuDetected started
    // true (i.e. never for a WebKit session, which starts false), so
    // there's nothing WebKit-unsafe about that reuse.
    const ortModule = effectiveGpuDetected
      ? await import("onnxruntime-web/webgpu")
      : await import("onnxruntime-web");

    const primaryModelPath = msg.modelBasePath
      ? resolveModelPath(msg.modelBasePath, effectiveGpuDetected)
      : msg.modelPath;
    if (!primaryModelPath) {
      throw new Error("Inference Worker 'init' message needs either modelPath or modelBasePath");
    }

    // WebGPU first, WASM as fallback -- not a replacement (Issue #35). ORT
    // assigns each graph node to the first EP in this list that supports
    // it, falling back to the next one per-node rather than all-or-nothing,
    // so an op WebGPU can't run (e.g. some quantized INT8 ops, see
    // docs/verification/inference-worker.md §8) still runs correctly on
    // WASM instead of failing the whole session. Omitting "webgpu" entirely
    // when effectiveGpuDetected is false (rather than always listing it)
    // matters for debugForce: "wasm-int8" needs WebGPU to never be
    // attempted at all, not just deprioritized, to actually reproduce the
    // iOS workaround's EP list on hardware that does have a real adapter.
    const primaryOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: effectiveGpuDetected ? ["webgpu", "wasm"] : ["wasm"],
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

    let resolvedModelPath = primaryModelPath;
    let gpuActive = effectiveGpuDetected;
    let usedFallback = false;
    try {
      adapter = new LungmaskAdapter(primaryModelPath);
      const modelBytes = await fetchModelBytes(primaryModelPath, reportDownloadProgress);
      session = await ortModule.InferenceSession.create(modelBytes, primaryOptions);
      await validateSession(adapter, session);
    } catch (err) {
      // Only a modelBasePath (hardware-auto-selected) caller run against an
      // (effectively) detected GPU has a fallback target worth retrying with
      // -- an explicit modelPath caller asked for one exact file and has
      // nothing else to fall back to, and a caller already on
      // effectiveGpuDetected=false is already on the INT8/WASM baseline
      // this fallback exists to reach.
      if (!msg.modelBasePath || !effectiveGpuDetected) {
        throw err;
      }
      console.error(
        "Inference Worker: primary session (effectiveGpuDetected=true) failed, falling back to INT8/WASM",
        err,
      );
      usedFallback = true;
      gpuActive = false;
      resolvedModelPath = resolveModelPath(msg.modelBasePath, false);
      adapter = new LungmaskAdapter(resolvedModelPath);
      const fallbackBytes = await fetchModelBytes(resolvedModelPath, reportDownloadProgress);
      // Force wasm-only for the retry -- webgpu just failed for this
      // session, so there's no reason to let ORT attempt it again here.
      session = await ortModule.InferenceSession.create(fallbackBytes, { executionProviders: ["wasm"] });
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
    // surface the difference. debugForce is echoed back (not just read)
    // so a tester can visually confirm from the ack alone that the
    // override was actually received and applied, not silently ignored.
    (self as unknown as Worker).postMessage({
      type: "init-complete",
      modelPath: resolvedModelPath,
      gpuDetected: gpuActive,
      usedFallback,
      debugForce: msg.debugForce ?? null,
    });
    return;
  }

  if (msg.type === "hu-slice") {
    const { volumeId, sliceIndex, width, height, data } = msg;
    pendingBatch.push({ volumeId, sliceIndex, slice: { data: new Float32Array(data), width, height } });
    scheduleBatchFlush();
  }
};
