import type * as ort from "onnxruntime-web";
import type { CropBbox } from "./preprocess.js";
import { zoomNearest } from "./ndimage.js";

/**
 * REQ-A17 postprocess: argmax over the class-logit dimension, then upscale
 * to the original DICOM slice resolution using Nearest-Neighbor
 * interpolation ONLY. No other interpolation method is implemented here —
 * bilinear/trilinear would produce non-integer values between class
 * indices, which REQ-C01 explicitly prohibits (CLAUDE.md guardrail #3).
 *
 * The model's native 256x256 output describes only `cropBbox`'s
 * sub-region of the original slice, not the full frame — `preprocess.ts`
 * cropped to that bounding box *before* resizing to 256x256 (matching the
 * real lungmask.utils.preprocess). Upscaling straight to the full
 * original resolution without restoring this crop stretches a
 * smaller-than-full-frame region to fill the whole slice, both
 * over-magnifying and mis-positioning the mask (found via real visual
 * inspection in the Shell — the mask rendered oversized, spilling past
 * the actual body outline). This upscales to the crop's own size first,
 * then pastes it into a zero-initialized full-resolution canvas at the
 * crop's original offset.
 */
export function lungmaskPostprocess(
  logits: ort.Tensor,
  cropBbox: CropBbox,
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

  const { minRow, minCol, maxRow, maxCol } = cropBbox;
  const cropHeight = maxRow - minRow;
  const cropWidth = maxCol - minCol;
  const upscaledCrop = zoomNearest(
    { data: nativeArgmax, height: nativeHeight, width: nativeWidth },
    cropHeight,
    cropWidth,
  );

  // Zero-initialized (= background, class 0) full-resolution canvas —
  // everything outside the body-mask bbox was never part of the model's
  // input and has no prediction to place there.
  const full = new Uint8Array(originalShape.height * originalShape.width);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      full[(minRow + y) * originalShape.width + (minCol + x)] = upscaledCrop.data[y * cropWidth + x] as number;
    }
  }

  return full;
}
