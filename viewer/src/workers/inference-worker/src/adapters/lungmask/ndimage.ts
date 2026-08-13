/**
 * Minimal reimplementations of the scipy.ndimage / skimage.measure primitives
 * `lungmask.utils.simple_bodymask`/`crop_and_resize` use, matched op-for-op
 * (same structuring elements, connectivity, iteration counts) against
 * lungmask 0.2.20's source rather than approximated, so the TS output can be
 * diffed against the real Python pipeline (see ../../../scripts/export_reference_fixtures.py).
 */

export interface Grid2D {
  data: Float32Array;
  height: number;
  width: number;
}

export interface BinaryGrid2D {
  data: Uint8Array;
  height: number;
  width: number;
}

/**
 * scipy.ndimage.zoom's default (grid_mode=False) coordinate mapping: output
 * index 0 maps exactly to input index 0, and the last output index maps
 * exactly to the last input index ("align corners"), NOT a half-pixel-center
 * mapping. `ix = o * (inSize-1) / (outSize-1)`, 0 when outSize==1.
 */
function srcCoord(o: number, outSize: number, inSize: number): number {
  if (outSize <= 1) return 0;
  return (o * (inSize - 1)) / (outSize - 1);
}

/** scipy.ndimage.zoom(order=0): nearest-neighbor resample. */
export function zoomNearest(src: Grid2D, dstHeight: number, dstWidth: number): Grid2D {
  const out = new Float32Array(dstHeight * dstWidth);
  for (let y = 0; y < dstHeight; y++) {
    const sy = clampIndex(Math.round(srcCoord(y, dstHeight, src.height)), src.height);
    for (let x = 0; x < dstWidth; x++) {
      const sx = clampIndex(Math.round(srcCoord(x, dstWidth, src.width)), src.width);
      out[y * dstWidth + x] = src.data[sy * src.width + sx]!;
    }
  }
  return { data: out, height: dstHeight, width: dstWidth };
}

/** scipy.ndimage.zoom(order=1): bilinear resample. */
export function zoomBilinear(src: Grid2D, dstHeight: number, dstWidth: number): Grid2D {
  const out = new Float32Array(dstHeight * dstWidth);
  for (let y = 0; y < dstHeight; y++) {
    const sy = srcCoord(y, dstHeight, src.height);
    const y0 = clampIndex(Math.floor(sy), src.height);
    const y1 = clampIndex(y0 + 1, src.height);
    const fy = clamp01(sy - Math.floor(sy));
    for (let x = 0; x < dstWidth; x++) {
      const sx = srcCoord(x, dstWidth, src.width);
      const x0 = clampIndex(Math.floor(sx), src.width);
      const x1 = clampIndex(x0 + 1, src.width);
      const fx = clamp01(sx - Math.floor(sx));

      const v00 = src.data[y0 * src.width + x0]!;
      const v01 = src.data[y0 * src.width + x1]!;
      const v10 = src.data[y1 * src.width + x0]!;
      const v11 = src.data[y1 * src.width + x1]!;
      const top = v00 + (v01 - v00) * fx;
      const bottom = v10 + (v11 - v10) * fx;
      out[y * dstWidth + x] = top + (bottom - top) * fy;
    }
  }
  return { data: out, height: dstHeight, width: dstWidth };
}

function clampIndex(i: number, size: number): number {
  return Math.min(Math.max(i, 0), size - 1);
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

const CROSS_OFFSETS: ReadonlyArray<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** scipy.ndimage.binary_erosion, default cross structuring element, border treated as 0. */
export function binaryErosion(mask: BinaryGrid2D, iterations: number): BinaryGrid2D {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(cur.height * cur.width);
    for (let y = 0; y < cur.height; y++) {
      for (let x = 0; x < cur.width; x++) {
        if (cur.data[y * cur.width + x] === 0) continue;
        let keep = true;
        for (const [dy, dx] of CROSS_OFFSETS) {
          const ny = y + dy;
          const nx = x + dx;
          const val = ny < 0 || ny >= cur.height || nx < 0 || nx >= cur.width ? 0 : cur.data[ny * cur.width + nx]!;
          if (val === 0) {
            keep = false;
            break;
          }
        }
        out[y * cur.width + x] = keep ? 1 : 0;
      }
    }
    cur = { data: out, height: cur.height, width: cur.width };
  }
  return cur;
}

/** scipy.ndimage.binary_dilation, default cross structuring element, border treated as 0. */
export function binaryDilation(mask: BinaryGrid2D, iterations: number): BinaryGrid2D {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(cur.height * cur.width);
    for (let y = 0; y < cur.height; y++) {
      for (let x = 0; x < cur.width; x++) {
        if (cur.data[y * cur.width + x] === 1) {
          out[y * cur.width + x] = 1;
          continue;
        }
        let hit = false;
        for (const [dy, dx] of CROSS_OFFSETS) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || ny >= cur.height || nx < 0 || nx >= cur.width) continue;
          if (cur.data[ny * cur.width + nx] === 1) {
            hit = true;
            break;
          }
        }
        out[y * cur.width + x] = hit ? 1 : 0;
      }
    }
    cur = { data: out, height: cur.height, width: cur.width };
  }
  return cur;
}

/** scipy.ndimage.binary_closing(mask): dilate then erode, default cross SE, 1 iteration. */
export function binaryClosing(mask: BinaryGrid2D): BinaryGrid2D {
  return binaryErosion(binaryDilation(mask, 1), 1);
}

/**
 * scipy.ndimage.binary_fill_holes(mask, structure=np.ones((3,3))): fill any
 * background region not 8-connected to the image border.
 */
export function binaryFillHoles(mask: BinaryGrid2D): BinaryGrid2D {
  const { height, width } = mask;
  const reachable = new Uint8Array(height * width);
  const stack: number[] = [];

  const pushIfBackground = (y: number, x: number) => {
    const idx = y * width + x;
    if (mask.data[idx] === 0 && reachable[idx] === 0) {
      reachable[idx] = 1;
      stack.push(idx);
    }
  };

  for (let x = 0; x < width; x++) {
    pushIfBackground(0, x);
    pushIfBackground(height - 1, x);
  }
  for (let y = 0; y < height; y++) {
    pushIfBackground(y, 0);
    pushIfBackground(y, width - 1);
  }

  while (stack.length > 0) {
    const idx = stack.pop()!;
    const y = Math.floor(idx / width);
    const x = idx % width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        const ny = y + dy;
        const nx = x + dx;
        if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
        pushIfBackground(ny, nx);
      }
    }
  }

  const out = new Uint8Array(height * width);
  for (let i = 0; i < out.length; i++) {
    out[i] = mask.data[i] === 1 || reachable[i] === 0 ? 1 : 0;
  }
  return { data: out, height, width };
}

export interface Region {
  label: number;
  area: number;
  /** [minRow, minCol, maxRow, maxCol) — maxRow/maxCol exclusive, matching skimage regionprops.bbox */
  bbox: [number, number, number, number];
}

/** Connected-component labeling. connectivity 1 = 4-connected (matches skimage connectivity=1), 2 = 8-connected (matches skimage's ndim-default). */
export function labelComponents(mask: BinaryGrid2D, connectivity: 1 | 2): { labels: Int32Array; regions: Region[] } {
  const { height, width } = mask;
  const labels = new Int32Array(height * width).fill(0);
  const offsets: Array<[number, number]> =
    connectivity === 1
      ? [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]
      : [
          [-1, -1],
          [-1, 0],
          [-1, 1],
          [1, -1],
          [1, 0],
          [1, 1],
          [0, -1],
          [0, 1],
        ];

  const regions: Region[] = [];
  let nextLabel = 1;
  const stack: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const startIdx = y * width + x;
      if (mask.data[startIdx] !== 1 || labels[startIdx] !== 0) continue;

      const label = nextLabel++;
      labels[startIdx] = label;
      stack.push(startIdx);
      let area = 0;
      let minRow = y;
      let maxRow = y;
      let minCol = x;
      let maxCol = x;

      while (stack.length > 0) {
        const idx = stack.pop()!;
        const cy = Math.floor(idx / width);
        const cx = idx % width;
        area++;
        if (cy < minRow) minRow = cy;
        if (cy > maxRow) maxRow = cy;
        if (cx < minCol) minCol = cx;
        if (cx > maxCol) maxCol = cx;

        for (const [dy, dx] of offsets) {
          const ny = cy + dy;
          const nx = cx + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (mask.data[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = label;
            stack.push(nIdx);
          }
        }
      }

      regions.push({ label, area, bbox: [minRow, minCol, maxRow + 1, maxCol + 1] });
    }
  }

  return { labels, regions };
}
