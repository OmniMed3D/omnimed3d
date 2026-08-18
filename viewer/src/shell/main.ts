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
 * Not yet the full Shell (REQ-R06) -- no file-picking UI exists yet, so
 * `omnimed3dTestHooks` below exposes the entry points a real UI (or, for
 * now, the Playwright e2e test in viewer/tests/e2e/) drives directly.
 * Issue #20 ("Finalize Mask Data Contract and Rendering Integration")
 * tracks this wiring; an earlier version of this file's comment
 * mislabeled it "issue #21" (that number is unrelated -- see
 * docs/prd/CHANGELOG.md's own correction of the same mistake).
 */

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

interface MaskSliceMessage {
  type: "mask-slice";
  volumeId: string;
  sliceIndex: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

function waitForEngineReady(): Promise<void> {
  return new Promise((resolve) => {
    function poll() {
      // Must not call _engine_is_ready() before onRuntimeInitialized has
      // fired (index.html sets this flag there) -- doing so trips
      // Emscripten's ASSERTIONS=1 check and aborts the whole module.
      if (window.__engineRuntimeInitialized && window.Module._engine_is_ready()) {
        resolve();
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

function mintVolumeId(): string {
  const id = crypto.randomUUID();
  volumeIdMap.set(id, nextNumericVolumeId++);
  currentVolumeId = id;
  return id;
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
  await waitForEngineReady();
  document.getElementById("shell-status")!.textContent = "shell: engine ready";

  const parseWorker = new Worker(new URL("../workers/parse-worker/src/worker.ts", import.meta.url), {
    type: "module",
  });
  const inferenceWorker = new Worker(new URL("../workers/inference-worker/src/worker.ts", import.meta.url), {
    type: "module",
  });

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

  parseWorker.onmessage = (event: MessageEvent<HuSliceMessage | VolumeReadyMessage>) => {
    const msg = event.data;
    if (msg.type === "hu-slice") {
      inferenceWorker.postMessage(msg, [msg.data]);
    } else if (msg.type === "volume-ready") {
      engineLoadVolume(msg);
    }
  };

  inferenceWorker.onmessage = (event: MessageEvent<MaskSliceMessage>) => {
    const msg = event.data;
    if (msg.type === "mask-slice") {
      engineApplyMaskSlice(msg);
    }
  };

  window.omnimed3dTestHooks = {
    parseWorker,
    inferenceWorker,
    startNewVolume: mintVolumeId,
    currentVolumeId: () => currentVolumeId,
  };

  document.getElementById("shell-status")!.textContent =
    "shell: ready for input (no file-picker UI yet -- see omnimed3dTestHooks)";
}

main();
