import type * as ort from "onnxruntime-web";
import { zoomNearest } from "./ndimage.js";

/**
 * REQ-A17 postprocess: argmax over the class-logit dimension, then upscale
 * to the original DICOM slice resolution using Nearest-Neighbor
 * interpolation ONLY. No other interpolation method is implemented here —
 * bilinear/trilinear would produce non-integer values between class
 * indices, which REQ-C01 explicitly prohibits (CLAUDE.md guardrail #3).
 */
export function lungmaskPostprocess(
  logits: ort.Tensor,
  originalShape: { width: number; height: number },
): Uint8Array {
  const [, numClasses, nativeHeight, nativeWidth] = logits.dims as [number, number, number, number];
  const values = logits.data as Float32Array | number[];

  const nativeArgmax = new Float32Array(nativeHeight * nativeWidth);
  const spatialSize = nativeHeight * nativeWidth;
  for (let pixel = 0; pixel < spatialSize; pixel++) {
    let bestClass = 0;
    let bestValue = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const v = Number(values[c * spatialSize + pixel]);
      if (v > bestValue) {
        bestValue = v;
        bestClass = c;
      }
    }
    nativeArgmax[pixel] = bestClass;
  }

  const upscaled = zoomNearest(
    { data: nativeArgmax, height: nativeHeight, width: nativeWidth },
    originalShape.height,
    originalShape.width,
  );

  return Uint8Array.from(upscaled.data);
}
