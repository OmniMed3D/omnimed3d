import type * as ort from "onnxruntime-web";

/**
 * A single 2D slice in original DICOM resolution, in Hounsfield Units.
 * This is the Parse Worker's output per REQ-A04/A05 (2026-08-12 update):
 * decoding + HU conversion only, no model-specific preprocessing.
 */
export interface HuSlice {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Per-model adapter: owns everything REQ-A04 assigns to the Inference
 * Worker — model-specific preprocessing, the forward pass, and
 * postprocessing (REQ-A17: argmax + Nearest-Neighbor-only upscale).
 */
export interface SegmentationAdapter {
  readonly modelPath: string;
  readonly numClasses: number;

  preprocess(slice: HuSlice): ort.Tensor;
  infer(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor>;
  postprocess(logits: ort.Tensor, originalShape: { width: number; height: number }): Uint8Array;
}
