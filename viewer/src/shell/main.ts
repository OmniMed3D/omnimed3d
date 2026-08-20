/**
 * Web Application Shell orchestration (REQ-R06, PRD §5.3.2). Owns:
 * - minting/tracking `volumeId` per loaded volume and discarding any
 *   `mask-slice` whose `volumeId` doesn't match (stale-slice protection);
 * - routing Parse Worker output (`hu-slice` -> Inference Worker,
 *   `volume-ready` -> engine_load_volume) and Inference Worker output
 *   (`mask-slice` -> engine_apply_mask_slice);
 * - the malloc/HEAPU8/free pattern for crossing into WASM linear memory,
 *   the same pattern engine/tests/wasm_smoke/shell.html already proved.
 *
 * `loadVolumeFromFiles` below is the shared entry point for turning
 * picked files into a loaded volume -- both `filePicker.ts` (issue #34,
 * REQ-R06) and `omnimed3dTestHooks` (kept for the Playwright e2e tests in
 * viewer/tests/e2e/) go through the same Worker instances and volumeId
 * bookkeeping, so out-of-order/stale-volumeId behavior is identical
 * regardless of which one drove the load. `cameraControls.ts`/
 * `windowLevelControls.ts` call the engine's WASM camera/window-level
 * exports directly (no Shell-owned state to route through -- unlike
 * volume/mask data, those calls don't need a volumeId or Worker hop).
 *
 * Issue #20 ("Finalize Mask Data Contract and Rendering Integration")
 * tracks the original mask-routing wiring; an earlier version of this
 * file's comment mislabeled it "issue #21" (that number is unrelated --
 * see docs/prd/CHANGELOG.md's own correction of the same mistake).
 */
import { setupFilePicker } from "./filePicker.js";
import { setupCameraControls } from "./cameraControls.js";
import { setupWindowLevelControls } from "./windowLevelControls.js";
import { setupViewControls, notifyVolumeLoaded } from "./viewControls.js";
import { setupQualityControls } from "./qualityControls.js";
import { setupTfDetailControls } from "./tfDetailControls.js";
import { setupClipControls, notifyVolumeAabbLoaded } from "./clipControls.js";
import { setupCustomColormapControls } from "./customColormapControls.js";
import { setupCanvasResize } from "./canvasResize.js";
import { setLoading } from "./loadingIndicator.js";
import { setupPanelDrag, setupPanelCollapse } from "./panelDrag.js";
import { setupInferenceControls } from "./inferenceControls.js";
import { setupDemoCtControls } from "./demoCtControls.js";
import { setupTooltips } from "./tooltipManager.js";

interface EngineModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  _engine_is_ready(): number;
  _engine_load_volume(
    volumeId: number,
    dataPtr: number,
    byteLength: number,
    width: number,
    height: number,
    depth: number,
    spacingX: number,
    spacingY: number,
    spacingZ: number,
  ): void;
  _engine_apply_mask_slice(
    volumeId: number,
    sliceIndex: number,
    width: number,
    height: number,
    dataPtr: number,
    byteLength: number,
  ): void;
  _engine_set_window_level(center: number, width: number): void;
  _engine_set_colormap_preset(presetId: number): void;
  _engine_orbit_camera(deltaYawPixels: number, deltaPitchPixels: number): void;
  _engine_zoom_camera(wheelDeltaSign: number): void;
  _engine_set_view_mode(mode: number): void;
  _engine_set_axial_slice_index(index: number): void;
  _engine_resize(width: number, height: number): void;
  _engine_set_quality_tier(tier: number): void;
  _engine_set_shading_enabled(enabled: number): void;
  _engine_set_extinction(extinction: number): void;
  _engine_set_density_scale(scale: number): void;
  _engine_set_threshold(threshold: number): void;
  _engine_set_clip_box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void;
  _engine_set_gradient_opacity_strength(strength: number): void;
  _engine_set_occlusion_enabled(enabled: number): void;
  _engine_set_custom_lut_colors(
    lowR: number,
    lowG: number,
    lowB: number,
    highR: number,
    highG: number,
    highB: number,
  ): void;
}

declare global {
  interface Window {
    Module: EngineModule;
    __engineRuntimeInitialized?: boolean;
    omnimed3dTestHooks: {
      parseWorker: Worker;
      inferenceWorker: Worker;
      startNewVolume(): string;
      currentVolumeId(): string | null;
    };
  }
}

interface HuSliceMessage {
  type: "hu-slice";
  volumeId: string;
  sliceIndex: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

interface VolumeReadyMessage {
  type: "volume-ready";
  volumeId: string;
  width: number;
  height: number;
  depth: number;
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  data: ArrayBuffer;
}

interface ParseErrorMessage {
  type: "parse-error";
  message: string;
}

interface MaskSliceMessage {
  type: "mask-slice";
  volumeId: string;
  sliceIndex: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

// Issue #40: resolves false on timeout instead of polling forever --
// previously a WebGPU-unavailable browser/device (no adapter, so
// _engine_is_ready() never becomes true) left the Shell stuck at "shell:
// loading..." indefinitely with no user-facing signal. 15s matches the
// timeout the e2e suite already uses for #shell-status waits.
function waitForEngineReady(timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    function poll() {
      // Must not call _engine_is_ready() before onRuntimeInitialized has
      // fired (index.html sets this flag there) -- doing so trips
      // Emscripten's ASSERTIONS=1 check and aborts the whole module.
      if (window.__engineRuntimeInitialized && window.Module._engine_is_ready()) {
        resolve(true);
        return;
      }
      if (performance.now() >= deadline) {
        resolve(false);
        return;
      }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  });
}

/**
 * `volumeId`s crossing into WASM are `uint32_t` (engine_load_volume's ABI),
 * distinct from the `string` volumeId used at every JS-to-JS boundary --
 * this Shell is exactly the layer responsible for that conversion (see
 * docs/current/SESSION_STATUS_2026-08-16.md's "volumeId is a string..."
 * note). A simple incrementing counter is enough since only this Shell
 * ever mints one.
 */
let nextNumericVolumeId = 1;
const volumeIdMap = new Map<string, number>();
let currentVolumeId: string | null = null;

// Assigned once in main() -- module-scope (not a main()-local) so
// loadVolumeFromFiles can reach the same Worker instance
// omnimed3dTestHooks/the message-routing handlers below use, rather than
// each caller getting its own disconnected Worker with its own state.
let parseWorkerInstance: Worker | undefined;

// True once the Inference Worker has ack'd an "init" (model load). Issue
// #34 adds a real file-picker that can load a volume without any model
// ever being loaded (no "load model" UI exists yet -- out of scope, see
// the plan this issue implements: the repo's only model fixture is a
// dummy, plumbing-only ONNX graph, see
// tests/fixtures/generate-dummy-onnx.py). Before this flag existed,
// hu-slice was unconditionally forwarded to the Inference Worker, which
// threw ("received a slice before 'init'") the first time a real
// file-picker load happened with no model loaded -- reachable only via
// the e2e test before, which always initialized a (dummy) model first.
let inferenceWorkerReady = false;

function mintVolumeId(): string {
  const id = crypto.randomUUID();
  volumeIdMap.set(id, nextNumericVolumeId++);
  currentVolumeId = id;
  return id;
}

/**
 * Shared entry point for turning picked files into a loaded volume
 * (issue #34) -- mints a volumeId and posts a `parse-series` message to
 * the real Parse Worker, the same pattern `omnimed3dTestHooks`-driven
 * flows already used by hand. `files` may be a single- or multi-file
 * series (e.g. one file per axial slice).
 */
/**
 * File-agnostic core of loadVolumeFromFiles -- mints a volumeId and posts
 * a `parse-series` message to the real Parse Worker. Split out (2026-08-21,
 * demo-CT loader follow-up) because nothing downstream of this point ever
 * touches `File`-specific APIs (confirmed against parse-worker/src/
 * worker.ts and pipeline.ts -- the `ParseSeriesMessage` contract is plain
 * `ArrayBuffer[]`), so a caller that already has buffers (e.g. from
 * `fetch()` rather than a picked `File`) can skip straight to this.
 */
export async function loadVolumeFromBuffers(buffers: ArrayBuffer[]): Promise<string> {
  if (!parseWorkerInstance) {
    throw new Error("loadVolumeFromBuffers called before the Shell finished initializing");
  }
  setLoading(true);
  // Clear a stale error from a previous failed attempt -- this is the
  // user trying again.
  document.getElementById("load-error")!.hidden = true;
  try {
    const volumeId = mintVolumeId();
    parseWorkerInstance.postMessage({ type: "parse-series", volumeId, files: buffers }, buffers);
    return volumeId;
  } catch (error) {
    // Only the synchronous/promise-rejection path here clears loading
    // itself -- once the parse-series message is posted, loading stays
    // true until either engineLoadVolume's success path or
    // parseWorker.onerror's failure path clears it.
    setLoading(false);
    throw error;
  }
}

/**
 * Shared entry point for turning picked files into a loaded volume
 * (issue #34) -- the same pattern `omnimed3dTestHooks`-driven flows
 * already used by hand. `files` may be a single- or multi-file series
 * (e.g. one file per axial slice).
 */
export async function loadVolumeFromFiles(files: File[]): Promise<string> {
  const buffers = await Promise.all(files.map((file) => file.arrayBuffer()));
  return loadVolumeFromBuffers(buffers);
}

/**
 * message defaults to the file-picker's own wording -- callers with a more
 * specific failure (e.g. the demo-CT loader's manifest-fetch 404, which
 * isn't "an invalid file" but a dev-setup problem) can override it.
 */
export function showLoadError(
  message = "Couldn't load this file -- it may not be a valid or supported DICOM series.",
): void {
  setLoading(false);
  const loadError = document.getElementById("load-error");
  if (loadError) {
    loadError.textContent = message;
    loadError.hidden = false;
  }
}

function withWasmBuffer<T>(byteLength: number, fn: (ptr: number) => T): T {
  const module = window.Module;
  const ptr = module._malloc(byteLength);
  try {
    return fn(ptr);
  } finally {
    module._free(ptr);
  }
}

function engineLoadVolume(msg: VolumeReadyMessage): void {
  const numericId = volumeIdMap.get(msg.volumeId);
  if (numericId === undefined) {
    console.error(`Shell: volume-ready for unknown volumeId=${msg.volumeId}, ignoring`);
    return;
  }
  const bytes = new Uint8Array(msg.data);
  withWasmBuffer(bytes.byteLength, (ptr) => {
    window.Module.HEAPU8.set(bytes, ptr);
    window.Module._engine_load_volume(
      numericId,
      ptr,
      bytes.byteLength,
      msg.width,
      msg.height,
      msg.depth,
      msg.spacingX,
      msg.spacingY,
      msg.spacingZ,
    );
  });
  notifyVolumeLoaded(msg.depth);
  notifyVolumeAabbLoaded(msg.width, msg.height, msg.depth, msg.spacingX, msg.spacingY, msg.spacingZ);
  setLoading(false);
  // Visual polish pass: the empty-canvas hint has served its purpose
  // once a volume has actually rendered.
  document.getElementById("empty-hint")!.hidden = true;
}

function engineApplyMaskSlice(msg: MaskSliceMessage): void {
  if (msg.volumeId !== currentVolumeId) {
    console.log(`Shell: discarding mask-slice for stale volumeId=${msg.volumeId} (current=${currentVolumeId})`);
    return;
  }
  const numericId = volumeIdMap.get(msg.volumeId);
  if (numericId === undefined) {
    console.error(`Shell: mask-slice for unknown volumeId=${msg.volumeId}, ignoring`);
    return;
  }
  const bytes = new Uint8Array(msg.data);
  withWasmBuffer(bytes.byteLength, (ptr) => {
    window.Module.HEAPU8.set(bytes, ptr);
    window.Module._engine_apply_mask_slice(numericId, msg.sliceIndex, msg.width, msg.height, ptr, bytes.byteLength);
  });
}

async function main() {
  const engineReady = await waitForEngineReady();
  if (!engineReady) {
    // Issue #40: WebGPU-unavailable (or otherwise stuck) fallback -- see
    // waitForEngineReady's own comment. Stop here rather than proceeding
    // to construct Workers/wire message routing against an engine that
    // will never respond.
    document.getElementById("shell-status")!.textContent = "shell: engine failed to start";
    document.getElementById("engine-error")!.hidden = false;
    return;
  }
  document.getElementById("shell-status")!.textContent = "shell: engine ready";
  setupCanvasResize();

  const parseWorker = new Worker(new URL("../workers/parse-worker/src/worker.ts", import.meta.url), {
    type: "module",
  });
  parseWorkerInstance = parseWorker;
  const inferenceWorker = new Worker(new URL("../workers/inference-worker/src/worker.ts", import.meta.url), {
    type: "module",
  });

  // Follow-up: a bad/unsupported file (e.g. not real DICOM, or a
  // compressed transfer syntax dicom-parser doesn't support -- see
  // CLAUDE.md #10) is now caught inside worker.ts's onmessage and
  // reported via a "parse-error" message (see below) -- self.onmessage
  // there is async, so a synchronous throw inside it becomes an
  // unhandled promise rejection rather than the worker's "error" event,
  // and onerror here never fires for it (confirmed via real browser e2e
  // testing). onerror stays wired as the fallback for genuinely uncaught
  // worker failures (e.g. a syntax error in worker.ts itself).
  parseWorker.onerror = (event: ErrorEvent) => {
    console.error("Shell: Parse Worker error", event.message, event);
    showLoadError();
  };

  // A full absolute URL (not an origin-relative path) is required here --
  // a dynamic import() of a root-relative specifier from inside a Worker
  // module fails to resolve in Chromium (empirically confirmed), even
  // though the exact same specifier resolves fine from the main thread.
  const wasmModulePath = new URL("/engine/dicom-parser/dicom_parser_wasm.mjs", location.origin).href;

  // Wait for parse-worker's own async WASM load to finish before sending
  // it anything else -- without this, a caller (or this Shell itself)
  // sending parse-file/parse-series right after "init" races the load
  // and hits worker.ts's "received a file before 'init'" error (found via
  // real browser e2e testing, not assumed safe).
  const parseWorkerReady = new Promise<void>((resolve) => {
    parseWorker.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "init-complete") {
        resolve();
      }
    };
  });
  parseWorker.postMessage({ type: "init", wasmModulePath });
  await parseWorkerReady;

  parseWorker.onmessage = (event: MessageEvent<HuSliceMessage | VolumeReadyMessage | ParseErrorMessage>) => {
    const msg = event.data;
    if (msg.type === "hu-slice") {
      if (inferenceWorkerReady) {
        inferenceWorker.postMessage(msg, [msg.data]);
      } else {
        console.log("Shell: dropping hu-slice -- no model loaded in the Inference Worker yet");
      }
    } else if (msg.type === "volume-ready") {
      engineLoadVolume(msg);
    } else if (msg.type === "parse-error") {
      console.error("Shell: Parse Worker reported a parse error", msg.message);
      showLoadError();
    }
  };

  inferenceWorker.onmessage = (event: MessageEvent<MaskSliceMessage | { type: string }>) => {
    const msg = event.data;
    if (msg.type === "init-complete") {
      inferenceWorkerReady = true;
    } else if (msg.type === "mask-slice") {
      engineApplyMaskSlice(msg as MaskSliceMessage);
    }
  };

  window.omnimed3dTestHooks = {
    parseWorker,
    inferenceWorker,
    startNewVolume: mintVolumeId,
    currentVolumeId: () => currentVolumeId,
  };

  setupFilePicker(loadVolumeFromFiles);
  setupCameraControls();
  setupWindowLevelControls();
  setupViewControls();
  setupQualityControls();
  setupTfDetailControls();
  setupClipControls();
  setupCustomColormapControls();
  setupPanelDrag();
  setupPanelCollapse();
  setupInferenceControls(inferenceWorker);
  setupDemoCtControls(loadVolumeFromBuffers, showLoadError);
  setupTooltips();

  document.getElementById("shell-status")!.textContent = "shell: ready for input";
  // Visual polish pass: shown only once there's actually something to
  // prompt -- not during the earlier load/init states, which already
  // have their own status text.
  document.getElementById("empty-hint")!.hidden = false;
}

main();
