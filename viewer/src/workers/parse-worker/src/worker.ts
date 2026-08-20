/**
 * Parse Worker entry point (REQ-A05). Thin `self.onmessage` wrapper
 * around pipeline.ts -- same pattern as
 * viewer/src/workers/inference-worker/src/worker.ts. Not
 * integration-tested in a real browser Worker as part of this pass (no
 * WebGPU under Node, and the Shell/REQ-R06 that would drive this doesn't
 * exist yet) -- see the plan's "Explicitly not in this milestone" section.
 *
 * `wasmModulePath` arrives via the `init` message rather than being
 * hardcoded, mirroring inference-worker's `InitMessage.modelPath` --
 * neither this file nor wasm.ts assumes anything about where the built
 * WASM artifact is served from (that's undecided until viewer/'s bundler
 * exists, per docs/adr/0003-inference-worker-in-viewer.md's Consequences).
 *
 * Two ways to drive this worker:
 * - `parse-file`: one DICOM file -> one `hu-slice` message (Inference
 *   Worker leg only; caller supplies `volumeId`/`sliceIndex` directly).
 * - `parse-series`: a whole series' files -> `hu-slice` messages for
 *   every slice *and* one final `volume-ready` message for the rendering
 *   engine (both legs from one pass -- see pipeline.ts's `assembleSeries`).
 * Which files belong to a series and minting `volumeId` is still the
 * caller's job either way.
 */
import { DicomParserWasm } from "./wasm.js";
import { parseSliceToHu, assembleSeries, type HuSliceMessage, type VolumeReadyMessage } from "./pipeline.js";

interface InitMessage {
  type: "init";
  wasmModulePath: string;
}

interface ParseFileMessage {
  type: "parse-file";
  volumeId: string;
  sliceIndex: number;
  fileBytes: ArrayBuffer;
}

interface ParseSeriesMessage {
  type: "parse-series";
  volumeId: string;
  files: ArrayBuffer[];
}

type IncomingMessage = InitMessage | ParseFileMessage | ParseSeriesMessage;

/** A bad/unsupported file (see pipeline.ts's UnsupportedPixelDataError/
 * InconsistentSeriesError, or a dicom-parser-wasm throw for non-DICOM
 * bytes) surfaces here rather than as a thrown exception. self.onmessage
 * is async, so a synchronous throw inside it rejects the handler's own
 * Promise instead of raising the worker's "error" event -- the browser
 * only translates *that* event into ErrorEvent on the main thread's
 * Worker.onerror; an unhandled rejection inside a worker fires
 * "unhandledrejection" on the worker's own global scope instead, which
 * the main thread never sees (confirmed via real browser e2e testing,
 * not assumed). */
export interface ParseErrorMessage {
  type: "parse-error";
  message: string;
}

let wasm: DicomParserWasm | undefined;

function requireWasm(): DicomParserWasm {
  if (!wasm) {
    throw new Error("Parse Worker received a file before 'init'");
  }
  return wasm;
}

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  const worker = self as unknown as Worker;

  try {
    if (msg.type === "init") {
      wasm = await DicomParserWasm.load(msg.wasmModulePath);
      // Callers have no other way to know the (async) WASM load finished --
      // without this ack, a caller sending parse-file/parse-series right
      // after init() races the load and hits requireWasm()'s "received a
      // file before 'init'" error (found via real browser e2e testing,
      // viewer/tests/e2e/shell-mask-integration.spec.ts).
      worker.postMessage({ type: "init-complete" });
      return;
    }

    if (msg.type === "parse-file") {
      const result: HuSliceMessage = parseSliceToHu(
        requireWasm(),
        new Uint8Array(msg.fileBytes),
        msg.volumeId,
        msg.sliceIndex,
      );
      worker.postMessage(result, [result.data]);
      return;
    }

    if (msg.type === "parse-series") {
      const files = msg.files.map((f) => new Uint8Array(f));
      const { sliceMessages, volume } = assembleSeries(requireWasm(), files, msg.volumeId);

      for (const sliceMessage of sliceMessages) {
        worker.postMessage(sliceMessage, [sliceMessage.data]);
      }
      const volumeMessage: VolumeReadyMessage = volume;
      worker.postMessage(volumeMessage, [volumeMessage.data]);
    }
  } catch (error) {
    const errorMessage: ParseErrorMessage = {
      type: "parse-error",
      message: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(errorMessage);
  }
};
