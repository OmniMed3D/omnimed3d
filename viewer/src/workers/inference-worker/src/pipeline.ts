import type * as ort from "onnxruntime-web";
import type { HuSlice, SegmentationAdapter } from "./adapters/types.js";

/** PRD §5.3.2 `mask-slice` message shape. `data` is Transferable. */
export interface MaskSliceMessage {
  type: "mask-slice";
  volumeId: string;
  sliceIndex: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface SliceRequest {
  volumeId: string;
  sliceIndex: number;
  slice: HuSlice;
}

/**
 * Runs one slice through preprocess -> infer -> postprocess (REQ-A17) and
 * shapes the result as a §5.3.2 mask-slice payload. Pure/environment-agnostic
 * so it's testable without a real Worker/postMessage — see worker.ts for the
 * thin `self.onmessage` wrapper.
 */
export async function runSlice<TMeta>(
  adapter: SegmentationAdapter<TMeta>,
  session: ort.InferenceSession,
  request: SliceRequest,
): Promise<MaskSliceMessage> {
  const { tensor, meta } = adapter.preprocess(request.slice);
  const logits = await adapter.infer(session, tensor);
  const data = adapter.postprocess(logits, meta, {
    width: request.slice.width,
    height: request.slice.height,
  });

  return {
    type: "mask-slice",
    volumeId: request.volumeId,
    sliceIndex: request.sliceIndex,
    width: request.slice.width,
    height: request.slice.height,
    data,
  };
}
