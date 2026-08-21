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
 * A model's preprocess step may need to hand postprocess some per-slice
 * metadata it computed (e.g. lungmask's crop bounding box, needed to place
 * the model's output back at the right offset/size — see
 * lungmask/postprocess.ts). Threaded explicitly through the return
 * value/parameter below rather than stored as mutable adapter-instance
 * state, so a future multi-slice batched adapter (REQ-A11) can preprocess
 * several slices before postprocessing any of them without one slice's
 * metadata clobbering another's.
 */
export interface PreprocessResult<TMeta> {
  tensor: ort.Tensor;
  meta: TMeta;
}

/**
 * Per-model adapter: owns everything REQ-A04 assigns to the Inference
 * Worker — model-specific preprocessing, the forward pass, and
 * postprocessing (REQ-A17: argmax + Nearest-Neighbor-only upscale).
 */
export interface SegmentationAdapter<TMeta = unknown> {
  readonly modelPath: string;
  readonly numClasses: number;

  preprocess(slice: HuSlice): PreprocessResult<TMeta>;
  infer(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor>;
  postprocess(logits: ort.Tensor, meta: TMeta, originalShape: { width: number; height: number }): Uint8Array;
}
