import type * as ort from "onnxruntime-web";
import type { HuSlice, SegmentationAdapter } from "../types.js";
import { lungmaskPreprocess } from "./preprocess.js";
import { lungmaskPostprocess } from "./postprocess.js";

/** classes: 0 = background, 1 = right lung, 2 = left lung (MODEL_SPEC.md). */
export class LungmaskAdapter implements SegmentationAdapter {
  readonly numClasses = 3;

  constructor(readonly modelPath: string) {}

  preprocess(slice: HuSlice): ort.Tensor {
    return lungmaskPreprocess(slice);
  }

  async infer(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor> {
    const outputs = await session.run({ input });
    const logits = outputs["logits"];
    if (!logits) {
      throw new Error("lungmask ONNX session did not return an output named 'logits'");
    }
    return logits;
  }

  postprocess(logits: ort.Tensor, originalShape: { width: number; height: number }): Uint8Array {
    return lungmaskPostprocess(logits, originalShape);
  }
}
