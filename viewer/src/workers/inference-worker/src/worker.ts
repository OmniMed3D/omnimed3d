/**
 * Inference Worker entry point (REQ-A03/A09/A16). Thin `self.onmessage`
 * wrapper around pipeline.ts — kept deliberately minimal since browser
 * bundling and the exact Parse Worker -> Inference Worker message shape
 * are not decided yet (REQ-C04 is still mostly open; see
 * ai-pipeline/inference-worker-handoff.md §5). Not integration-tested in a
 * browser as part of this pass — see the plan's "Deferred" section.
 *
 * The OUTGOING `mask-slice` shape (§5.3.2) is fixed; the INCOMING shape
 * below is this worker's own provisional assumption for a single HU slice,
 * not a confirmed cross-track contract.
 */
import * as ort from "onnxruntime-web";
import { LungmaskAdapter } from "./adapters/lungmask/index.js";
import type { SegmentationAdapter } from "./adapters/types.js";
import { runSlice, type MaskSliceMessage } from "./pipeline.js";

interface InitMessage {
  type: "init";
  modelPath: string;
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
    session = await ort.InferenceSession.create(msg.modelPath);
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
