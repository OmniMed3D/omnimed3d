// Value import (not `import type`) -- runBatch() below constructs new
// ort.Tensor instances directly, unlike runSlice() which only needed the
// type.
import * as ort from "onnxruntime-web";
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

/**
 * Runs several slices through one batched `session.run()` call instead of
 * one call per slice (Issue #24) -- every model call pays some fixed
 * overhead (dispatching work to the backend, etc.) on top of the actual
 * compute, so batching N slices together pays that overhead once instead
 * of N times. Still emits one `mask-slice` result per input slice (§5.3.2
 * progressive delivery is unaffected -- see worker.ts for how those
 * results get posted individually rather than as one batch message).
 *
 * Deliberately adapter-agnostic, with no new SegmentationAdapter methods:
 * `preprocess()`/`infer()`/`postprocess()` are called exactly as
 * `runSlice()` already calls them, one slice at a time for pre/post-
 * processing -- only the single `infer()` call in the middle operates on
 * a stacked batch tensor. Batch stacking only needs each preprocessed
 * tensor's own flat data length and dims (to build `[N, ...dims.slice(1)]`),
 * and un-stacking the output only needs its total length divided by N --
 * neither needs any model-specific knowledge (e.g. class count), so this
 * works for any adapter whose preprocess() output has a leading batch-of-1
 * dimension, matching this project's ONNX exports' `dynamic_axes` batch
 * dimension (confirmed directly against the FP32/INT8/FP16 .onnx files,
 * not just the export script, before starting this work).
 */
export async function runBatch<TMeta>(
  adapter: SegmentationAdapter<TMeta>,
  session: ort.InferenceSession,
  requests: SliceRequest[],
): Promise<MaskSliceMessage[]> {
  if (requests.length === 0) return [];

  console.log("[AI-DIAG] runBatch: preprocess starting, n =", requests.length);
  const preprocessed = requests.map((request) => adapter.preprocess(request.slice));
  console.log("[AI-DIAG] runBatch: preprocess done");
  const itemDims = preprocessed[0]!.tensor.dims;
  const itemSize = preprocessed[0]!.tensor.data.length;

  const batchedData = new Float32Array(itemSize * requests.length);
  preprocessed.forEach(({ tensor }, i) => {
    batchedData.set(tensor.data as Float32Array, i * itemSize);
  });
  const batchedInput = new ort.Tensor("float32", batchedData, [requests.length, ...itemDims.slice(1)]);
  console.log("[AI-DIAG] runBatch: batch tensor built, dims =", batchedInput.dims);

  console.log("[AI-DIAG] runBatch: infer() starting");
  const inferStart = performance.now();
  const batchedLogits = await adapter.infer(session, batchedInput);
  console.log("[AI-DIAG] runBatch: infer() resolved in", (performance.now() - inferStart).toFixed(0), "ms");
  const outputItemSize = batchedLogits.data.length / requests.length;
  const outputItemDims = [1, ...batchedLogits.dims.slice(1)];

  return requests.map((request, i) => {
    const itemData = (batchedLogits.data as Float32Array).subarray(
      i * outputItemSize,
      (i + 1) * outputItemSize,
    );
    const itemLogits = new ort.Tensor("float32", itemData, outputItemDims);
    const data = adapter.postprocess(itemLogits, preprocessed[i]!.meta, {
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
  });
}
