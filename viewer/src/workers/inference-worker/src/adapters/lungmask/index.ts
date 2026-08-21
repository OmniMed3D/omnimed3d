import type * as ort from "onnxruntime-web";
import type { HuSlice, PreprocessResult, SegmentationAdapter } from "../types.js";
import { lungmaskPreprocess, type CropBbox } from "./preprocess.js";
import { lungmaskPostprocess } from "./postprocess.js";

/** classes: 0 = background, 1 = right lung, 2 = left lung (MODEL_SPEC.md). */
export class LungmaskAdapter implements SegmentationAdapter<CropBbox> {
  readonly numClasses = 3;

  constructor(readonly modelPath: string) {}

  preprocess(slice: HuSlice): PreprocessResult<CropBbox> {
    const { tensor, cropBbox } = lungmaskPreprocess(slice);
    return { tensor, meta: cropBbox };
  }

  async infer(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor> {
    const outputs = await session.run({ input });
    const logits = outputs["logits"];
    if (!logits) {
      throw new Error("lungmask ONNX session did not return an output named 'logits'");
    }
    return logits;
  }

  postprocess(logits: ort.Tensor, meta: CropBbox, originalShape: { width: number; height: number }): Uint8Array {
    return lungmaskPostprocess(logits, meta, originalShape);
  }
}
