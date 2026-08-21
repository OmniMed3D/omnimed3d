import * as ort from "onnxruntime-web";
import type { HuSlice } from "../types.js";
import {
  binaryClosing,
  binaryDilation,
  binaryErosion,
  binaryFillHoles,
  labelComponents,
  zoomBilinear,
  zoomNearest,
  type BinaryGrid2D,
  type Grid2D,
} from "./ndimage.js";

// Must match conversion/adapters/lungmask/convert_to_onnx.py INPUT_RESOLUTION
const MODEL_RESOLUTION = 256;
const BODYMASK_GRID = 128;
const BODYMASK_THRESHOLD = -500;

/**
 * TS port of lungmask.utils.simple_bodymask (0.2.20): threshold at -500 HU
 * on a downsampled 128x128 grid, close + fill-holes + erode, keep the
 * largest 4-connected component, dilate, then upsample the binary mask
 * back to the original resolution — all via nearest-neighbor resampling.
 */
export function simpleBodymask(hu: Grid2D): BinaryGrid2D {
  const down = zoomNearest(hu, BODYMASK_GRID, BODYMASK_GRID);

  let mask: BinaryGrid2D = {
    data: Uint8Array.from(down.data, (v) => (v > BODYMASK_THRESHOLD ? 1 : 0)),
    height: BODYMASK_GRID,
    width: BODYMASK_GRID,
  };
  mask = binaryClosing(mask);
  mask = binaryFillHoles(mask);
  mask = binaryErosion(mask, 2);

  const { labels, regions } = labelComponents(mask, 1);
  if (regions.length > 0) {
    const largest = regions.reduce((a, b) => (b.area > a.area ? b : a));
    const isolated: BinaryGrid2D = {
      data: Uint8Array.from(labels, (l) => (l === largest.label ? 1 : 0)),
      height: BODYMASK_GRID,
      width: BODYMASK_GRID,
    };
    mask = binaryDilation(isolated, 2);
  }

  const upFloat = zoomNearest(
    { data: Float32Array.from(mask.data), height: BODYMASK_GRID, width: BODYMASK_GRID },
    hu.height,
    hu.width,
  );
  return {
    data: Uint8Array.from(upFloat.data, (v) => (v !== 0 ? 1 : 0)),
    height: hu.height,
    width: hu.width,
  };
}

/**
 * The body-mask bounding box `cropAndResize` cropped to before resizing to
 * the model's native resolution — [minRow, minCol) inclusive, [maxRow,
 * maxCol) exclusive, matching `labelComponents`' skimage-style convention.
 * The model's 256x256 output only ever describes this sub-region of the
 * original slice, never the full frame; `postprocess.ts` needs this to
 * place the upscaled mask back at the right offset/size instead of
 * stretching it to fill the whole slice (REQ-C01/A17 alignment).
 */
export interface CropBbox {
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
}

export interface PreprocessResult {
  tensor: ort.Tensor;
  cropBbox: CropBbox;
}

/**
 * TS port of lungmask.utils.crop_and_resize: crop the HU-clipped slice to
 * the body mask's bounding box (8-connected labeling, first region —
 * matches skimage.measure.label's ndim-default connectivity, unlike the
 * 4-connected call inside simpleBodymask), then bilinear-resize to the
 * model's native resolution.
 */
export function cropAndResize(clipped: Grid2D): { grid: Grid2D; bbox: CropBbox } {
  const bmask = simpleBodymask(clipped);
  const { regions } = labelComponents(bmask, 2);

  const [minRow, minCol, maxRow, maxCol] =
    regions.length > 0 ? regions[0]!.bbox : ([0, 0, clipped.height, clipped.width] as const);

  const cropHeight = maxRow - minRow;
  const cropWidth = maxCol - minCol;
  const cropped = new Float32Array(cropHeight * cropWidth);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      cropped[y * cropWidth + x] = clipped.data[(minRow + y) * clipped.width + (minCol + x)]!;
    }
  }

  return {
    grid: zoomBilinear({ data: cropped, height: cropHeight, width: cropWidth }, MODEL_RESOLUTION, MODEL_RESOLUTION),
    bbox: { minRow, minCol, maxRow, maxCol },
  };
}

/**
 * Full MODEL_SPEC.md 4-step preprocessing pipeline, matching
 * lungmask.utils.preprocess + the normalize step lungmask/mask.py applies
 * after it (see ../../../quantization/preprocessing.py for the Python
 * reference this mirrors):
 *   1. clip HU to [-1024, 600]
 *   2/3. body-mask threshold+morphology, crop to bbox, bilinear resize to 256x256
 *   4. re-clip upper bound at 600, normalize (HU + 1024) / 1624
 */
export function lungmaskPreprocess(slice: HuSlice): PreprocessResult {
  const clipped: Grid2D = {
    data: Float32Array.from(slice.data, (v) => Math.min(Math.max(v, -1024), 600)),
    height: slice.height,
    width: slice.width,
  };

  const { grid: resized, bbox } = cropAndResize(clipped);

  const normalized = new Float32Array(resized.data.length);
  for (let i = 0; i < normalized.length; i++) {
    const clampedUpper = Math.min(resized.data[i]!, 600);
    normalized[i] = (clampedUpper + 1024) / 1624;
  }

  return {
    tensor: new ort.Tensor("float32", normalized, [1, 1, MODEL_RESOLUTION, MODEL_RESOLUTION]),
    cropBbox: bbox,
  };
}
