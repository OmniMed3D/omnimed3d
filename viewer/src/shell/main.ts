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
 * picked files into a loaded volume -- both `filePicker.ts` (REQ-R06) and
 * `omnimed3dTestHooks` (kept for the Playwright e2e tests in
 * viewer/tests/e2e/) go through the same Worker instances and volumeId
 * bookkeeping, so out-of-order/stale-volumeId behavior is identical
 * regardless of which one drove the load. `cameraControls.ts`/
 * `windowLevelControls.ts` call the engine's WASM camera/window-level
 * exports directly (no Shell-owned state to route through -- unlike
 * volume/mask data, those calls don't need a volumeId or Worker hop).
 */
import { setupFilePicker } from "./filePicker.js";
import { setupDragAndDrop } from "./dragAndDropControls.js";
import { setupCameraControls } from "./cameraControls.js";
import { setFileWindowLevel, setupWindowLevelControls } from "./windowLevelControls.js";
import { setupViewControls, notifyVolumeLoaded, notifyNativeVolumeLoaded } from "./viewControls.js";
import { applyStartupAutoTier, setupQualityControls } from "./qualityControls.js";
import { setupTfDetailControls } from "./tfDetailControls.js";
import { setupClipControls, notifyVolumeAabbLoaded } from "./clipControls.js";
import { setupCustomColormapControls } from "./customColormapControls.js";
import { setupBackgroundControls } from "./backgroundControls.js";
import { setupCanvasResize } from "./canvasResize.js";
import { setLoading } from "./loadingIndicator.js";
import { setupPanelDrag, setupPanelCollapse } from "./panelDrag.js";
import { notifyMaskSliceApplied, notifyVolumeLoadedForInference, setupInferenceControls } from "./inferenceControls.js";
import { setupDemoCtControls } from "./demoCtControls.js";
import { setupTooltips } from "./tooltipManager.js";
import {
  getDownsampleFactor,
  setupDownsampleFactorControl,
  setupLowMemoryModeControl,
  shouldUseLowMemoryMode,
} from "./deviceTier.js";
import { notifyLowMemoryMode, setupStatsOverlay } from "./statsOverlay.js";
import { setupDeviceLostBanner } from "./deviceLostBanner.js";
import { setReloadAction, setupReloadVolumeControl } from "./reloadVolumeControl.js";
import { notifyInferenceEnded, notifyInferenceStarted } from "./renderPauseBanner.js";

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
    downsampleFactor: number,
  ): void;
  // MPR + native-slice feature -- see rhi::Device::loadNativeVolume's
  // header comment. No downsampleFactor.
  _engine_load_native_volume(
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
  // mode: 0=Orbit3D, 1=Slice2D (Axial/Sagittal/Coronal, see
  // _engine_set_slice_axis), 2=NativeSlice2D.
  _engine_set_view_mode(mode: number): void;
  _engine_set_slice_index(index: number): void;
  // axis: 0=Axial, 1=Sagittal, 2=Coronal (MPR).
  _engine_set_slice_axis(axis: number): void;
  _engine_set_native_slice_index(index: number): void;
  _engine_resize(width: number, height: number): void;
  _engine_set_quality_tier(tier: number): void;
  _engine_set_shading_enabled(enabled: number): void;
  _engine_set_extinction(extinction: number): void;
  _engine_set_density_scale(scale: number): void;
  _engine_set_threshold(threshold: number): void;
  _engine_set_clip_box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void;
  _engine_set_gradient_opacity_strength(strength: number): void;
  _engine_set_occlusion_enabled(enabled: number): void;
  _engine_set_mask_opacity(alpha: number): void;
  _engine_set_mask_overlay_enabled(enabled: number): void;
  _engine_set_custom_lut_colors(
    lowR: number,
    lowG: number,
    lowB: number,
    highR: number,
    highG: number,
    highB: number,
  ): void;
  _engine_set_background_color(r: number, g: number, b: number): void;
  // Perf/hardware debug overlay (statsOverlay.ts) -- see
  // engine/src/rhi/include/rhi/Device.hpp's getFrameStats()/
  // getHardwareInfo() header comments.
  _engine_get_frame_time_ms(): number;
  _engine_get_avg_frame_time_ms(): number;
  _engine_get_fps(): number;
  _engine_get_gpu_vendor(): number;
  _engine_get_gpu_architecture(): number;
  _engine_get_gpu_device(): number;
  _engine_get_gpu_description(): number;
  // GPU-side per-pass timing (WebGPU timestamp-query, optional feature) --
  // see rhi::Device::getGpuTiming's header comment.
  _engine_get_gpu_timing_supported(): number;
  _engine_get_gpu_raymarch_ms(): number;
  _engine_get_gpu_composite_ms(): number;
  _engine_get_gpu_axial_ms(): number;
  // Mobile OOM mitigation -- see rhi::Device::getDeviceLossState's
  // header comment.
  _engine_get_device_lost(): number;
  _engine_get_device_lost_reason(): number;
  _engine_get_device_lost_message(): number;
  _engine_get_uncaptured_error(): number;
  _engine_get_uncaptured_error_message(): number;
  _engine_clear_uncaptured_error(): void;
  // WASM-debug-only -- see WebGPUDevice::debugSimulateDeviceLost's
  // header comment. Declared here (not just cast-through in the e2e
  // test that uses it) since it's a real, always-compiled-in export,
  // not something stripped from production builds.
  _engine_debug_simulate_device_lost(): void;
  // Mobile OOM mitigation -- see rhi::Device::setRenderPaused's header
  // comment.
  _engine_set_render_paused(paused: number): void;
  UTF8ToString(ptr: number): string;
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
      armSegmentationForCurrentVolume(): void;
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
  // Mirrors pipeline.ts's VolumeReadyMessage. Vite/esbuild transpile
  // main.ts without type-checking it, so a missing field here fails no
  // build -- keep these two definitions in sync by hand when either
  // changes.
  windowCenter?: number;
  windowWidth?: number;
}

// MPR + native-slice feature -- mirrors pipeline.ts's
// NativeVolumeReadyMessage, same hand-sync caveat as VolumeReadyMessage
// above.
interface NativeVolumeReadyMessage {
  type: "native-volume-ready";
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

// Resolves false on timeout instead of polling forever --
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
 * this Shell is exactly the layer responsible for that conversion. A
 * simple incrementing counter is enough since only this Shell ever
 * mints one.
 */
let nextNumericVolumeId = 1;
const volumeIdMap = new Map<string, number>();
let currentVolumeId: string | null = null;

// Whether the currently-loaded volume was loaded in low-memory mode --
// gates render-pause-during-inference (see inferenceWorker.onmessage
// below and renderPauseBanner.ts): only low-memory devices benefit from
// giving inference exclusive GPU access, and on a full-memory device
// pausing rendering costs the user the ability to keep viewing the CT
// while segmentation runs, for no corresponding benefit.
let currentVolumeLowMemoryMode = false;

// Assigned once in main() -- module-scope (not a main()-local) so
// loadVolumeFromFiles can reach the same Worker instance
// omnimed3dTestHooks/the message-routing handlers below use, rather than
// each caller getting its own disconnected Worker with its own state.
let parseWorkerInstance: Worker | undefined;

// True once the Inference Worker has ack'd an "init" (model load). Issue
// #34 adds a real file-picker that can load a volume without any model
// ever being loaded. Before this flag existed, hu-slice was
// unconditionally forwarded to the Inference Worker, which threw
// ("received a slice before 'init'") the first time a real file-picker
// load happened with no model loaded -- reachable only via the e2e test
// before, which always initialized a (dummy) model first.
let inferenceWorkerReady = false;

// hu-slice messages that arrive before inferenceWorkerReady -- flushed in
// receipt order once "init-complete" fires (see inferenceWorker.onmessage
// below), instead of being dropped. Before this queue existed,
// "Load Demo CT" clicked before "Load Segmentation Model" finished loading
// silently lost every slice for that volume permanently (only a
// console.log as a trace, and nothing ever revisited a dropped slice) --
// a completely reasonable click order (view the volume first, decide to
// segment it after) to lose data over. Not volumeId-filtered going in: if
// the user starts loading a *different* volume before a model becomes
// ready, engineApplyMaskSlice() below already discards the resulting
// stale-volumeId mask-slice results on the way back (the same safety net
// the rest of this pipeline already relies on for out-of-order delivery),
// so flushing this queue unconditionally is still correct -- just
// possibly wasted inference work in that specific edge case, not a
// correctness bug.
const pendingHuSlices: HuSliceMessage[] = [];

// hu-slice only forwards to the Inference Worker when its volumeId
// matches this -- set by armSegmentationForCurrentVolume() (called from
// inferenceControls.ts's button on the model's first successful load and
// on every subsequent explicit "run it on this volume too" click), and
// reset to null by mintVolumeId() on every new volume so a freshly
// loaded one never inherits the previous volume's armed state.
let segmentationArmedVolumeId: string | null = null;

// Runs once, after the first volume actually renders -- checked here
// rather than at engine-ready time because an empty canvas
// renders trivially fast on any device and says nothing about real
// raymarch cost. 2000ms gives FrameStats's 60-sample rolling average
// (engine/src/utils/FrameStats.cpp) enough new post-load frames to
// converge even on a device rendering as slowly as ~5fps (real number
// from a mobile test that motivated this feature), not just fast ones.
const AUTO_TIER_CHECK_DELAY_MS = 2000;
// ~15fps -- PRD's own stated low-spec-device frame-rate floor (as
// opposed to the 30fps desktop target), reused here as the threshold
// below which the *default* (Medium) tier is considered too expensive
// for this device to start at.
const LOW_SPEC_FRAME_TIME_THRESHOLD_MS = 1000 / 15;
let autoTierChecked = false;

function scheduleAutoTierCheck(): void {
  if (autoTierChecked) {
    return;
  }
  autoTierChecked = true;
  setTimeout(() => {
    const avgFrameTimeMs = window.Module._engine_get_avg_frame_time_ms();
    if (avgFrameTimeMs > LOW_SPEC_FRAME_TIME_THRESHOLD_MS) {
      applyStartupAutoTier(0); // Low
    }
  }, AUTO_TIER_CHECK_DELAY_MS);
}

function mintVolumeId(): string {
  const id = crypto.randomUUID();
  volumeIdMap.set(id, nextNumericVolumeId++);
  currentVolumeId = id;
  // A new volume never inherits the previous one's armed-for-segmentation
  // state (see segmentationArmedVolumeId's own comment) -- discards
  // whatever was buffered for the volume being replaced, too, rather than
  // letting pendingHuSlices grow across every load nobody ever segments.
  segmentationArmedVolumeId = null;
  pendingHuSlices.length = 0;
  return id;
}

/**
 * Shared entry point for turning picked files into a loaded volume --
 * mints a volumeId and posts a `parse-series` message to the real Parse
 * Worker, the same pattern `omnimed3dTestHooks`-driven
 * flows already used by hand. `files` may be a single- or multi-file
 * series (e.g. one file per axial slice).
 */
/**
 * File-agnostic core of loadVolumeFromFiles -- mints a volumeId and posts
 * a `parse-series` message to the real Parse Worker. Split out because
 * nothing downstream of this point touches `File`-specific APIs (the
 * `ParseSeriesMessage` contract is plain `ArrayBuffer[]`), so a caller
 * that already has buffers (e.g. from `fetch()` rather than a picked
 * `File`) can skip straight to this.
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
 * Shared entry point for turning picked files into a loaded volume --
 * the same pattern `omnimed3dTestHooks`-driven flows already used by
 * hand. `files` may be a single- or multi-file series (e.g. one file
 * per axial slice).
 */
export async function loadVolumeFromFiles(files: File[]): Promise<string> {
  // Registered before the load itself so "Reload Volume" (reloadVolumeControl.ts)
  // redoes this same file selection -- re-reading from the original `File`
  // handles (disk/blob-backed) rather than a retained in-memory copy, see
  // that module's header comment for why that distinction matters here.
  setReloadAction(() => {
    loadVolumeFromFiles(files).catch((error: unknown) => {
      console.error("main: reload (from files) failed", error);
    });
  });
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
  const lowMemoryMode = shouldUseLowMemoryMode();
  const downsampleFactor = lowMemoryMode ? getDownsampleFactor() : 1;
  // Render-pause-during-inference (renderPauseBanner.ts) only makes sense
  // as a GPU-contention tradeoff on the memory-constrained devices this was
  // built for -- on a full-memory device, letting the CT keep rendering
  // while inference runs is strictly better UX, so the gate below tracks
  // *this loaded volume's* mode rather than re-reading shouldUseLowMemoryMode()
  // live (the checkbox doesn't retroactively resize an already-loaded
  // volume's textures either -- see deviceTier.ts's own comment).
  currentVolumeLowMemoryMode = lowMemoryMode;
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
      downsampleFactor,
    );
  });
  notifyLowMemoryMode(lowMemoryMode);
  notifyVolumeLoaded(msg.width, msg.height, msg.depth);
  notifyVolumeAabbLoaded(msg.width, msg.height, msg.depth, msg.spacingX, msg.spacingY, msg.spacingZ);
  notifyVolumeLoadedForInference(msg.volumeId, msg.depth);
  // The file's own VOI LUT window (pipeline.ts's assembleSeries, from
  // the first slice) is the only reliable per-series display hint for
  // data that isn't in Hounsfield Units (e.g. MR), but *auto-applying*
  // it here is wrong -- it permanently discards whatever the user had
  // picked as soon as a new volume loads, and looks bad as the
  // first-seen 3D Orbit
  // view (a 2D-slice-tuned window, raymarched). Just store it (always,
  // even when undefined, to clear a stale value from a previous volume
  // that didn't carry one) -- setFileWindowLevel wires it into the "From
  // File" preset option instead, so the user opts in rather than having
  // it forced on them.
  setFileWindowLevel(msg.windowCenter, msg.windowWidth, msg.modality);
  scheduleAutoTierCheck();
  setLoading(false);
  // Visual polish pass: the empty-canvas hint has served its purpose
  // once a volume has actually rendered.
  document.getElementById("empty-hint")!.hidden = true;
}

// MPR + native-slice feature -- loads the DICOM series' own original
// per-file slices into a second, independent GPU
// texture (rhi::Device::loadNativeVolume) for the NativeSlice2D view mode.
// Deliberately minimal compared to engineLoadVolume: no downsampling, no
// low-memory-mode bookkeeping, no mask/inference notification -- this view
// has no cinematic rendering or AI mask overlay path to feed.
function engineLoadNativeVolume(msg: NativeVolumeReadyMessage): void {
  const numericId = volumeIdMap.get(msg.volumeId);
  if (numericId === undefined) {
    console.error(`Shell: native-volume-ready for unknown volumeId=${msg.volumeId}, ignoring`);
    return;
  }
  const bytes = new Uint8Array(msg.data);
  withWasmBuffer(bytes.byteLength, (ptr) => {
    window.Module.HEAPU8.set(bytes, ptr);
    window.Module._engine_load_native_volume(
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
  notifyNativeVolumeLoaded(msg.depth);
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
  notifyMaskSliceApplied(msg.volumeId);
}

async function main() {
  const engineReady = await waitForEngineReady();
  if (!engineReady) {
    // WebGPU-unavailable (or otherwise stuck) fallback -- see
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

  // A bad/unsupported file (not real DICOM, or a compressed transfer
  // syntax dicom-parser doesn't support) is caught inside worker.ts's
  // onmessage and reported via a "parse-error" message (see below) --
  // self.onmessage there is async, so a synchronous throw inside it
  // becomes an unhandled promise rejection rather than the worker's
  // "error" event, and onerror here never fires for it. onerror stays
  // wired as the fallback for genuinely uncaught worker failures (e.g. a
  // syntax error in worker.ts itself).
  parseWorker.onerror = (event: ErrorEvent) => {
    console.error("Shell: Parse Worker error", event.message, event);
    showLoadError();
  };

  // A full absolute URL (not an origin-relative path) is required here --
  // a dynamic import() of a root-relative specifier from inside a Worker
  // module fails to resolve in Chromium, even though the same specifier
  // resolves fine from the main thread.
  const wasmModulePath = new URL("/engine/dicom-parser/dicom_parser_wasm.mjs", location.origin).href;

  // Wait for parse-worker's own async WASM load to finish before sending
  // it anything else -- without this, a caller (or this Shell itself)
  // sending parse-file/parse-series right after "init" races the load
  // and hits worker.ts's "received a file before 'init'" error.
  const parseWorkerReady = new Promise<void>((resolve) => {
    parseWorker.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "init-complete") {
        resolve();
      }
    };
  });
  parseWorker.postMessage({ type: "init", wasmModulePath });
  await parseWorkerReady;

  parseWorker.onmessage = (
    event: MessageEvent<HuSliceMessage | VolumeReadyMessage | NativeVolumeReadyMessage | ParseErrorMessage>,
  ) => {
    const msg = event.data;
    if (msg.type === "hu-slice") {
      if (inferenceWorkerReady && msg.volumeId === segmentationArmedVolumeId) {
        inferenceWorker.postMessage(msg, [msg.data]);
      } else {
        pendingHuSlices.push(msg);
      }
    } else if (msg.type === "volume-ready") {
      engineLoadVolume(msg);
    } else if (msg.type === "native-volume-ready") {
      engineLoadNativeVolume(msg);
    } else if (msg.type === "parse-error") {
      console.error("Shell: Parse Worker reported a parse error", msg.message);
      showLoadError();
    }
  };

  // Called once the model first finishes loading (inferenceControls.ts
  // arms whatever volume is currently loaded at that moment) and again
  // on every subsequent
  // explicit "run it on this volume too" button click (a *new* volume load
  // no longer arms itself -- see segmentationArmedVolumeId's own comment).
  // Flushes whatever hu-slices for this volume already arrived and got
  // buffered (e.g. the volume finished parsing before this arm call, or
  // before the model itself finished loading) rather than waiting for more
  // to arrive, which may never happen once a series' full slice set has
  // already been posted.
  function armSegmentationForCurrentVolume(): void {
    if (!currentVolumeId) {
      console.log("Shell: armSegmentationForCurrentVolume called with no volume loaded, ignoring");
      return;
    }
    segmentationArmedVolumeId = currentVolumeId;
    if (!inferenceWorkerReady) {
      return; // nothing to flush yet -- the model itself hasn't finished loading
    }
    const toForward = pendingHuSlices.filter((pending) => pending.volumeId === segmentationArmedVolumeId);
    const remaining = pendingHuSlices.filter((pending) => pending.volumeId !== segmentationArmedVolumeId);
    pendingHuSlices.length = 0;
    pendingHuSlices.push(...remaining);
    for (const pending of toForward) {
      inferenceWorker.postMessage(pending, [pending.data]);
    }
  }

  inferenceWorker.onmessage = (event: MessageEvent<MaskSliceMessage | { type: string }>) => {
    const msg = event.data;
    if (msg.type === "init-complete") {
      // No pendingHuSlices flush here -- armSegmentationForCurrentVolume()
      // (called by inferenceControls.ts's own init-complete listener,
      // registered after this one) owns flushing, and only for whichever
      // volume it actually arms; flushing everything here regardless of
      // segmentationArmedVolumeId would forward stale-volume slices too.
      inferenceWorkerReady = true;
    } else if (msg.type === "mask-slice") {
      engineApplyMaskSlice(msg as MaskSliceMessage);
    } else if (msg.type === "inference-started") {
      // Gated to low-memory mode -- see currentVolumeLowMemoryMode's own
      // comment. notifyInferenceEnded() below stays unconditional (it's
      // already a no-op unless actually paused, per renderPauseBanner.ts's
      // idempotency guard) so a mode change mid-batch can never leave
      // rendering stuck paused.
      if (currentVolumeLowMemoryMode) {
        notifyInferenceStarted();
      }
    } else if (msg.type === "inference-ended") {
      notifyInferenceEnded();
    }
  };

  window.omnimed3dTestHooks = {
    parseWorker,
    inferenceWorker,
    startNewVolume: mintVolumeId,
    currentVolumeId: () => currentVolumeId,
    // Segmentation does not auto-arm a newly loaded volume just because
    // the model is already active (see segmentationArmedVolumeId's own
    // comment) -- tests that want a hu-slice round trip for a given
    // volume must arm it explicitly here, same as a real user clicking
    // "Run Segmentation" would.
    armSegmentationForCurrentVolume,
  };

  // ?debug=1 starts the stats overlay visible and the control panel
  // collapsed, so a device test doesn't need to reach a
  // checkbox that can end up under the mobile browser's own bottom
  // toolbar -- see setupStatsOverlay/setupPanelCollapse's own comments.
  const debugMode = new URLSearchParams(location.search).get("debug") === "1";

  setupFilePicker(loadVolumeFromFiles);
  setupDragAndDrop(loadVolumeFromFiles);
  setupCameraControls();
  setupWindowLevelControls();
  setupViewControls();
  setupQualityControls();
  setupLowMemoryModeControl();
  setupDownsampleFactorControl();
  setupReloadVolumeControl();
  setupTfDetailControls();
  setupClipControls();
  setupCustomColormapControls();
  setupBackgroundControls();
  setupPanelDrag("control-panel", "panel-drag-grip");
  setupPanelCollapse(debugMode);
  setupPanelDrag("stats-overlay", "stats-overlay-drag-handle");
  setupInferenceControls(inferenceWorker, armSegmentationForCurrentVolume);
  setupDemoCtControls(loadVolumeFromBuffers, showLoadError, setReloadAction);
  setupTooltips();
  setupStatsOverlay(debugMode);
  setupDeviceLostBanner();

  document.getElementById("shell-status")!.textContent = "shell: ready for input";
  // Visual polish pass: shown only once there's actually something to
  // prompt -- not during the earlier load/init states, which already
  // have their own status text.
  document.getElementById("empty-hint")!.hidden = false;
}

main();
