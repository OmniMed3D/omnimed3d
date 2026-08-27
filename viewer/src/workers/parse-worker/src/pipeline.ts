/**
 * Pure, environment-agnostic DICOM -> Hounsfield-Unit conversion (same
 * pattern as inference-worker/src/pipeline.ts's `runSlice`) -- given raw
 * DICOM file bytes, parses via the shared dicom-parser WASM module and
 * produces the message shapes the two downstream consumers already
 * expect:
 *
 * - `hu-slice`: viewer/src/workers/inference-worker/src/worker.ts's
 *   `HuSliceMessage`, documented there as "the Parse Worker's output per
 *   REQ-A04/A05, 2026-08-12 update". One 2D slice, original resolution,
 *   Hounsfield Units, float32.
 * - `volume-ready`: a single assembled 3D volume for
 *   `rhi::Device::loadVolume`/`engine_load_volume`
 *   (engine/src/rhi/include/rhi/Device.hpp, engine/src/main_wasm.cpp),
 *   which uploads its input buffer directly into an `R16Float` GPU
 *   texture -- see halfFloat.ts for the conversion this requires.
 *
 * Scope (both Milestone 1 and 2): 16-bit pixel data only (signed or
 * unsigned) -- the only case verified against real bytes so far
 * (engine/tests/fixtures/CT_small.dcm). Anything else is a clear
 * rejection, matching dicom-parser's own fail-loud philosophy rather than
 * silently miscomputing.
 *
 * Orientation (issue #21): when a slice has both ImageOrientationPatient
 * and ImagePositionPatient, pixel data is normalized to the canonical
 * convention documented in orientation.ts/viewer/README.md before it
 * leaves this module, and `assembleSeries` orders slices geometrically
 * (projecting ImagePositionPatient onto the slice normal) instead of by
 * `instanceNumber`. A slice missing either tag falls back to
 * pass-through pixel data / `instanceNumber` ordering, loudly
 * (`console.warn`) rather than silently.
 */
import type { DicomWasmImageInfo, ImageParser } from "./wasm.js";
import { float32ToFloat16 } from "./halfFloat.js";
import {
  applyTransform,
  canonicalToSourceIndex,
  computeObliqueResampleGrid,
  computeOrientationTransform,
  cross,
  dot,
  UnsupportedOrientationError,
  type ObliqueSeriesGeometry,
  type OrientationTransform,
  type Vec3,
} from "./orientation.js";

/** Field-for-field match of inference-worker's HuSliceMessage. */
export interface HuSliceMessage {
  type: "hu-slice";
  volumeId: string;
  sliceIndex: number;
  width: number;
  height: number;
  data: ArrayBuffer; // float32, row-major, length = width*height*4
}

/** Matches engine_load_volume's parameters exactly (engine/src/main_wasm.cpp). */
export interface VolumeReadyMessage {
  type: "volume-ready";
  volumeId: string;
  width: number;
  height: number;
  depth: number;
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  data: ArrayBuffer; // R16Float, row-major, length = width*height*depth*2
  /**
   * The series' own VOI LUT display window (DICOM PS3.3 C.11.2), taken
   * from the first slice -- present only when that slice actually carried
   * the tags (real files vary: some carry a per-slice-recomputed window,
   * some carry none at all). Bug report, 2026-08-27: UPENN-GBM brain MR
   * rendered as a blown-out white block under the app's CT-calibrated
   * "Brain" preset (center 40/width 80 HU) because MR pixel values aren't
   * Hounsfield Units at all -- the file's own window (e.g. center
   * 212/width 493 for that series) is the only reliable way to know how
   * to display it. The Shell (main.ts) applies this once on load rather
   * than leaving whatever preset/manual value was already active.
   */
  windowCenter?: number;
  windowWidth?: number;
  /**
   * DICOM Modality (PS3.3 C.7.3.1.1.1, e.g. "CT", "MR"), taken from the
   * first slice -- undefined if that slice carried no Modality tag. Lets
   * the Shell tell real HU CT data apart from non-HU data (MR etc.)
   * without relying on "does this file carry a VOI LUT window" as a proxy
   * (bug report, 2026-08-27 follow-up: real CT series commonly carry one
   * too, wrongly auto-selecting "From File" over the app's CT presets).
   */
  modality?: string;
}

/**
 * MPR + native-slice feature (2026-08-27 user request): the DICOM series'
 * own original per-file slices, in their native acquisition order and
 * resolution -- entirely separate from `VolumeReadyMessage`, which may be
 * trilinear-resampled onto a canonical LPS grid (see assembleObliqueSeries)
 * and is what `engine_load_volume`'s Slice2D/Orbit3D views render. This is
 * what `engine_load_native_volume`'s NativeSlice2D view renders instead --
 * always produced (every series has native data; for an already
 * axis-aligned series it's the same pixel data as `VolumeReadyMessage`
 * before that path's transpose/flip normalization, not literally identical
 * output). No windowCenter/windowWidth of its own -- the Shell reuses
 * whatever `VolumeReadyMessage` already established for the same series.
 */
export interface NativeVolumeReadyMessage {
  type: "native-volume-ready";
  volumeId: string;
  width: number;
  height: number;
  depth: number;
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  data: ArrayBuffer; // R16Float, row-major, length = width*height*depth*2
}

export class UnsupportedPixelDataError extends Error {
  constructor(bitsAllocated: number) {
    super(`parse-worker only supports 16-bit pixel data, got bitsAllocated=${bitsAllocated}`);
  }
}

export class InconsistentSeriesError extends Error {
  constructor(message: string) {
    super(`parse-worker: inconsistent series -- ${message}`);
  }
}

interface ParsedSlice {
  image: DicomWasmImageInfo;
  hu: Float32Array;
  /** Post-orientation-transform dimensions/spacing -- differ from image.rows/columns/pixelSpacing* when the transform transposed the grid. */
  rows: number;
  columns: number;
  spacingRow: number;
  spacingColumn: number;
  /** null when the slice lacked ImageOrientationPatient/ImagePositionPatient -- no geometric ordering possible for the series it belongs to. */
  orientation: OrientationTransform | null;
}

interface RawParsedSlice {
  image: DicomWasmImageInfo;
  /** Untransformed HU data -- rows/columns match `image.rows`/`image.columns` exactly, no orientation normalization applied yet. */
  hu: Float32Array;
}

/** Decodes pixel data -> HU for one file, with no orientation handling at all -- shared by the axis-aligned fast path (`applyAxisAlignedOrientation`) and the oblique-resample fallback (`assembleObliqueSeries`), which each need the raw grid for different reasons (per-slice transform vs. whole-series resampling). */
function parseSliceRaw(wasm: ImageParser, fileBytes: Uint8Array): RawParsedSlice {
  const image = wasm.parseImage(fileBytes);

  if (image.bitsAllocated !== 16) {
    throw new UnsupportedPixelDataError(image.bitsAllocated);
  }

  const pixelCount = image.rows * image.columns;
  const raw =
    image.pixelRepresentation === 1
      ? new Int16Array(image.pixelData.buffer, image.pixelData.byteOffset, pixelCount)
      : new Uint16Array(image.pixelData.buffer, image.pixelData.byteOffset, pixelCount);

  const hu = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    hu[i] = (raw[i] as number) * image.rescaleSlope + image.rescaleIntercept;
  }

  return { image, hu };
}

/**
 * Applies the axis-aligned fast path on top of a raw-parsed slice: passes
 * pixel data through unchanged when orientation tags are absent, otherwise
 * normalizes via `computeOrientationTransform` -- which throws
 * `UnsupportedOrientationError` for a genuinely oblique acquisition. That
 * throw is intentional here (this function has no series-wide context to
 * fall back to); `assembleSeries` is what catches it and switches to
 * `assembleObliqueSeries` when parsing a whole series.
 */
function applyAxisAlignedOrientation(raw: RawParsedSlice): ParsedSlice {
  const { image, hu } = raw;

  if (!image.hasImageOrientationPatient || !image.hasImagePositionPatient) {
    console.warn(
      "parse-worker: slice is missing ImageOrientationPatient/ImagePositionPatient -- " +
        "pixel data passed through without orientation normalization",
    );
    return {
      image,
      hu,
      rows: image.rows,
      columns: image.columns,
      spacingRow: image.pixelSpacingRow,
      spacingColumn: image.pixelSpacingColumn,
      orientation: null,
    };
  }

  const orientation = computeOrientationTransform({
    row: image.imageOrientationPatient.slice(0, 3) as Vec3,
    column: image.imageOrientationPatient.slice(3, 6) as Vec3,
  });
  const transformed = applyTransform(hu, image.rows, image.columns, orientation);

  return {
    image,
    hu: transformed.data,
    rows: transformed.rows,
    columns: transformed.columns,
    spacingRow: orientation.transpose ? image.pixelSpacingColumn : image.pixelSpacingRow,
    spacingColumn: orientation.transpose ? image.pixelSpacingRow : image.pixelSpacingColumn,
    orientation,
  };
}

function parseSliceHu(wasm: ImageParser, fileBytes: Uint8Array): ParsedSlice {
  return applyAxisAlignedOrientation(parseSliceRaw(wasm, fileBytes));
}

export function parseSliceToHu(
  wasm: ImageParser,
  fileBytes: Uint8Array,
  volumeId: string,
  sliceIndex: number,
): HuSliceMessage {
  const { hu, rows, columns } = parseSliceHu(wasm, fileBytes);
  return {
    type: "hu-slice",
    volumeId,
    sliceIndex,
    width: columns,
    height: rows,
    data: hu.buffer as ArrayBuffer,
  };
}

/** dot(ImagePositionPatient, normal) * sliceAxisSign -- ascending sorts slice-index-increasing = patient Superior, regardless of row/column handedness (see orientation.ts). */
function geometricSortKey(slice: ParsedSlice): number {
  const orientation = slice.orientation as OrientationTransform;
  const position: Vec3 = [
    slice.image.imagePositionPatient[0],
    slice.image.imagePositionPatient[1],
    slice.image.imagePositionPatient[2],
  ];
  return dot(position, orientation.normal) * orientation.sliceAxisSign;
}

function orientationsConsistent(a: OrientationTransform, b: OrientationTransform): boolean {
  return (
    a.transpose === b.transpose &&
    a.flipRows === b.flipRows &&
    a.flipColumns === b.flipColumns &&
    a.sliceAxisSign === b.sliceAxisSign
  );
}

type OrderingMethod = "geometric" | "instanceNumber" | "oblique-resample";

/** Shared by both the axis-aligned and oblique-resample paths -- turns a final, already-ordered/consistent-dimension `ParsedSlice[]` into the two output messages `assembleSeries` produces. */
/**
 * Builds the NativeSlice2D payload from already-sorted raw (untransformed)
 * slices -- shared by the axis-aligned and instanceNumber-fallback paths.
 * assembleObliqueSeries builds its own directly from `sourceStack` instead
 * (it already has the exact same raw-pixel-order data assembled for
 * resampling, so re-deriving it here would just duplicate that work).
 */
function buildNativeVolume(sortedRaw: RawParsedSlice[], volumeId: string): NativeVolumeReadyMessage {
  const first = sortedRaw[0] as RawParsedSlice;
  const rows = first.image.rows;
  const columns = first.image.columns;
  const depth = sortedRaw.length;
  const pixelCount = rows * columns;
  const volumeData = new Uint16Array(pixelCount * depth);

  sortedRaw.forEach((raw, sliceIndex) => {
    for (let i = 0; i < pixelCount; i++) {
      volumeData[sliceIndex * pixelCount + i] = float32ToFloat16(raw.hu[i] as number);
    }
  });

  return {
    type: "native-volume-ready",
    volumeId,
    width: columns,
    height: rows,
    depth,
    spacingX: first.image.pixelSpacingColumn,
    spacingY: first.image.pixelSpacingRow,
    spacingZ: first.image.sliceThickness,
    data: volumeData.buffer as ArrayBuffer,
  };
}

function assembleFromParsedSlices(
  parsed: ParsedSlice[],
  volumeId: string,
  orderingMethod: OrderingMethod,
): { sliceMessages: HuSliceMessage[]; volume: VolumeReadyMessage; orderingMethod: OrderingMethod } {
  const first = parsed[0] as ParsedSlice;
  const { rows, columns } = first;
  for (const slice of parsed) {
    if (slice.rows !== rows || slice.columns !== columns) {
      throw new InconsistentSeriesError(
        `slice dimensions vary across the series (expected ${rows}x${columns}, ` +
          `got ${slice.rows}x${slice.columns})`,
      );
    }
  }

  const depth = parsed.length;
  const pixelCount = rows * columns;
  const sliceMessages: HuSliceMessage[] = [];
  const volumeData = new Uint16Array(pixelCount * depth);

  parsed.forEach((slice, sliceIndex) => {
    sliceMessages.push({
      type: "hu-slice",
      volumeId,
      sliceIndex,
      width: columns,
      height: rows,
      data: slice.hu.buffer as ArrayBuffer,
    });
    for (let i = 0; i < pixelCount; i++) {
      volumeData[sliceIndex * pixelCount + i] = float32ToFloat16(slice.hu[i] as number);
    }
  });

  const volume: VolumeReadyMessage = {
    type: "volume-ready",
    volumeId,
    width: columns,
    height: rows,
    depth,
    spacingX: first.spacingColumn,
    spacingY: first.spacingRow,
    spacingZ: first.image.sliceThickness,
    data: volumeData.buffer as ArrayBuffer,
    windowCenter: first.image.hasWindowCenter ? first.image.windowCenter : undefined,
    windowWidth: first.image.hasWindowWidth ? first.image.windowWidth : undefined,
    modality: first.image.modality || undefined,
  };

  return { sliceMessages, volume, orderingMethod };
}

/** Sorts `rawParsed`/`parsed` by the same key, in lockstep (index-paired rather than sorting `parsed` alone) -- `buildNativeVolume` needs the raw slices in the exact same order the main volume ends up in, and `Array.prototype.sort` gives no other way to guarantee two separate arrays end up permuted identically. */
function sortInLockstep<T>(
  rawParsed: RawParsedSlice[],
  parsed: ParsedSlice[],
  key: (slice: ParsedSlice) => T,
  compare: (a: T, b: T) => number,
): { rawParsed: RawParsedSlice[]; parsed: ParsedSlice[] } {
  const order = parsed
    .map((_, i) => i)
    .sort((a, b) => compare(key(parsed[a] as ParsedSlice), key(parsed[b] as ParsedSlice)));
  return {
    rawParsed: order.map((i) => rawParsed[i] as RawParsedSlice),
    parsed: order.map((i) => parsed[i] as ParsedSlice),
  };
}

/** Axis-aligned fast path: every slice has orientation tags and normalizes via `computeOrientationTransform` (may throw UnsupportedOrientationError -- caller decides what to do with that). */
function assembleAxisAlignedSeries(
  rawParsed: RawParsedSlice[],
  volumeId: string,
): {
  sliceMessages: HuSliceMessage[];
  volume: VolumeReadyMessage;
  nativeVolume: NativeVolumeReadyMessage;
  orderingMethod: OrderingMethod;
} {
  const parsedUnsorted = rawParsed.map((raw) => applyAxisAlignedOrientation(raw));

  const first = parsedUnsorted[0]!.orientation as OrientationTransform;
  for (const slice of parsedUnsorted) {
    if (!orientationsConsistent(first, slice.orientation as OrientationTransform)) {
      throw new InconsistentSeriesError(
        "slice orientation varies across the series (row/column direction cosines don't agree)",
      );
    }
  }
  const sorted = sortInLockstep(rawParsed, parsedUnsorted, geometricSortKey, (a, b) => a - b);

  const nativeVolume = buildNativeVolume(sorted.rawParsed, volumeId);
  return { ...assembleFromParsedSlices(sorted.parsed, volumeId, "geometric"), nativeVolume };
}

/** Missing-tags fallback: at least one slice lacks orientation/position, so no geometric ordering is possible. */
function assembleFallbackOrderedSeries(
  rawParsed: RawParsedSlice[],
  volumeId: string,
): {
  sliceMessages: HuSliceMessage[];
  volume: VolumeReadyMessage;
  nativeVolume: NativeVolumeReadyMessage;
  orderingMethod: OrderingMethod;
} {
  console.warn(
    "parse-worker: not every slice has ImageOrientationPatient/ImagePositionPatient -- " +
      "falling back to instanceNumber ordering instead of geometric",
  );
  const parsedUnsorted = rawParsed.map((raw) => applyAxisAlignedOrientation(raw));
  const sorted = sortInLockstep(
    rawParsed,
    parsedUnsorted,
    (slice) => slice.image.instanceNumber,
    (a, b) => a - b,
  );

  const nativeVolume = buildNativeVolume(sorted.rawParsed, volumeId);
  return { ...assembleFromParsedSlices(sorted.parsed, volumeId, "instanceNumber"), nativeVolume };
}

/** Magnitude + unit-vector helper -- ImageOrientationPatient's cosines are nominally unit length already, but this guards against DS-string rounding same as classifyAxis's own tolerance. */
function normalizeVec3(v: Vec3): Vec3 {
  const magnitude = Math.hypot(v[0], v[1], v[2]);
  if (magnitude < 1e-6) {
    throw new InconsistentSeriesError("degenerate (zero-length) orientation direction cosine");
  }
  return [v[0] / magnitude, v[1] / magnitude, v[2] / magnitude];
}

/**
 * Oblique-acquisition fallback (2026-08-27, bug report: UPENN-GBM brain MR
 * series -- real neuro MR is routinely angled a few to ~20 degrees off
 * axial to align with the AC-PC line, which `computeOrientationTransform`'s
 * axis-aligned-only fast path rejects). Resamples the whole stack onto a
 * canonical-axis-aligned grid via trilinear interpolation instead of
 * rejecting the series outright -- see orientation.ts's
 * `computeObliqueResampleGrid`/`canonicalToSourceIndex` for the geometry
 * this builds on.
 */
function assembleObliqueSeries(
  rawParsed: RawParsedSlice[],
  volumeId: string,
): {
  sliceMessages: HuSliceMessage[];
  volume: VolumeReadyMessage;
  nativeVolume: NativeVolumeReadyMessage;
  orderingMethod: OrderingMethod;
} {
  const first = rawParsed[0] as RawParsedSlice;
  const rows = first.image.rows;
  const columns = first.image.columns;
  for (const raw of rawParsed) {
    if (raw.image.rows !== rows || raw.image.columns !== columns) {
      throw new InconsistentSeriesError(
        `slice dimensions vary across the series (expected ${rows}x${columns}, ` +
          `got ${raw.image.rows}x${raw.image.columns})`,
      );
    }
  }

  const rowUnit = normalizeVec3(first.image.imageOrientationPatient.slice(0, 3) as Vec3);
  const columnUnit = normalizeVec3(first.image.imageOrientationPatient.slice(3, 6) as Vec3);
  const normal = cross(rowUnit, columnUnit);

  const ORIENTATION_EPSILON = 1e-3;
  for (const raw of rawParsed) {
    const r = normalizeVec3(raw.image.imageOrientationPatient.slice(0, 3) as Vec3);
    const c = normalizeVec3(raw.image.imageOrientationPatient.slice(3, 6) as Vec3);
    if (dot(r, rowUnit) < 1 - ORIENTATION_EPSILON || dot(c, columnUnit) < 1 - ORIENTATION_EPSILON) {
      throw new InconsistentSeriesError(
        "slice orientation varies across the series (row/column direction cosines don't agree)",
      );
    }
  }

  const sorted = [...rawParsed].sort(
    (a, b) => dot(a.image.imagePositionPatient as Vec3, normal) - dot(b.image.imagePositionPatient as Vec3, normal),
  );

  const depth = sorted.length;
  const firstPos = sorted[0]!.image.imagePositionPatient as Vec3;
  const lastPos = sorted[depth - 1]!.image.imagePositionPatient as Vec3;
  const sliceSpacing =
    depth > 1 ? Math.abs(dot(lastPos, normal) - dot(firstPos, normal)) / (depth - 1) : sorted[0]!.image.sliceThickness;
  if (!(sliceSpacing > 1e-6)) {
    throw new InconsistentSeriesError(
      "degenerate (zero) slice spacing -- cannot resample an oblique series with coincident slice positions",
    );
  }

  const geometry: ObliqueSeriesGeometry = {
    row: rowUnit,
    column: columnUnit,
    normal,
    origin: firstPos,
    pixelSpacingRow: first.image.pixelSpacingRow,
    pixelSpacingColumn: first.image.pixelSpacingColumn,
    sliceSpacing,
  };
  const grid = computeObliqueResampleGrid(geometry, rows, columns, depth);

  const pixelCount = rows * columns;
  const sourceStack = new Float32Array(pixelCount * depth);
  sorted.forEach((raw, i) => {
    sourceStack.set(raw.hu, i * pixelCount);
  });

  const outPixelCount = grid.rows * grid.columns;
  const volumeData = new Uint16Array(outPixelCount * grid.depth);
  const sliceMessages: HuSliceMessage[] = [];

  for (let outSlice = 0; outSlice < grid.depth; outSlice++) {
    const sliceHu = new Float32Array(outPixelCount);
    for (let outRow = 0; outRow < grid.rows; outRow++) {
      for (let outCol = 0; outCol < grid.columns; outCol++) {
        const patientPos: Vec3 = [
          (grid.origin[0] as number) + outCol * grid.spacingX,
          (grid.origin[1] as number) + outRow * grid.spacingY,
          (grid.origin[2] as number) + outSlice * grid.spacingZ,
        ];
        const [srcRow, srcCol, srcSlice] = canonicalToSourceIndex(patientPos, geometry);
        sliceHu[outRow * grid.columns + outCol] = sampleTrilinear(
          sourceStack,
          rows,
          columns,
          depth,
          srcRow as number,
          srcCol as number,
          srcSlice as number,
        );
      }
    }
    sliceMessages.push({
      type: "hu-slice",
      volumeId,
      sliceIndex: outSlice,
      width: grid.columns,
      height: grid.rows,
      data: sliceHu.buffer as ArrayBuffer,
    });
    for (let i = 0; i < outPixelCount; i++) {
      volumeData[outSlice * outPixelCount + i] = float32ToFloat16(sliceHu[i] as number);
    }
  }

  const volume: VolumeReadyMessage = {
    type: "volume-ready",
    volumeId,
    width: grid.columns,
    height: grid.rows,
    depth: grid.depth,
    spacingX: grid.spacingX,
    spacingY: grid.spacingY,
    spacingZ: grid.spacingZ,
    data: volumeData.buffer as ArrayBuffer,
    windowCenter: first.image.hasWindowCenter ? first.image.windowCenter : undefined,
    windowWidth: first.image.hasWindowWidth ? first.image.windowWidth : undefined,
    modality: first.image.modality || undefined,
  };

  // NativeSlice2D payload (MPR + native-slice feature, 2026-08-27 user
  // request) -- `sourceStack` is already exactly this: the raw per-file
  // slices in native acquisition order, assembled above for resampling.
  // Reused directly rather than re-derived, since it's the exact same
  // rows x columns x depth data this function already built.
  const nativeVolumeData = new Uint16Array(sourceStack.length);
  for (let i = 0; i < sourceStack.length; i++) {
    nativeVolumeData[i] = float32ToFloat16(sourceStack[i] as number);
  }
  const nativeVolume: NativeVolumeReadyMessage = {
    type: "native-volume-ready",
    volumeId,
    width: columns,
    height: rows,
    depth,
    spacingX: first.image.pixelSpacingColumn,
    spacingY: first.image.pixelSpacingRow,
    spacingZ: sliceSpacing,
    data: nativeVolumeData.buffer as ArrayBuffer,
  };

  return { sliceMessages, volume, nativeVolume, orderingMethod: "oblique-resample" };
}

/**
 * Trilinear sample of a `sourceRows`x`sourceColumns`x`sourceDepth` stack
 * (row-major within each slice, slices concatenated) at fractional
 * (rowIndex, columnIndex, sliceIndex). Out-of-bounds contributions are
 * treated as 0 rather than clamped -- an oblique stack's bounding-box
 * output grid legitimately has corners with no source data underneath
 * them (the source stack doesn't fill its own bounding box).
 */
function sampleTrilinear(
  stack: Float32Array,
  sourceRows: number,
  sourceColumns: number,
  sourceDepth: number,
  rowIndex: number,
  columnIndex: number,
  sliceIndex: number,
): number {
  const r0 = Math.floor(rowIndex);
  const c0 = Math.floor(columnIndex);
  const s0 = Math.floor(sliceIndex);
  const fr = rowIndex - r0;
  const fc = columnIndex - c0;
  const fs = sliceIndex - s0;

  const at = (r: number, c: number, s: number): number => {
    if (r < 0 || r >= sourceRows || c < 0 || c >= sourceColumns || s < 0 || s >= sourceDepth) {
      return 0;
    }
    return stack[s * sourceRows * sourceColumns + r * sourceColumns + c] as number;
  };

  const c00 = at(r0, c0, s0) * (1 - fc) + at(r0, c0 + 1, s0) * fc;
  const c10 = at(r0 + 1, c0, s0) * (1 - fc) + at(r0 + 1, c0 + 1, s0) * fc;
  const c01 = at(r0, c0, s0 + 1) * (1 - fc) + at(r0, c0 + 1, s0 + 1) * fc;
  const c11 = at(r0 + 1, c0, s0 + 1) * (1 - fc) + at(r0 + 1, c0 + 1, s0 + 1) * fc;

  const c0z = c00 * (1 - fr) + c10 * fr;
  const c1z = c01 * (1 - fr) + c11 * fr;

  return c0z * (1 - fs) + c1z * fs;
}

/**
 * Parses every file in `files` exactly once and produces both the
 * per-slice `hu-slice` messages (Inference Worker leg) and one assembled
 * `volume-ready` message (rendering-engine leg) from that single pass.
 *
 * Ordering/path selection: geometric (axis-aligned fast path) when every
 * slice has orientation/position and normalizes via
 * `computeOrientationTransform`; oblique-resample when every slice has
 * orientation/position but isn't axis-aligned (see assembleObliqueSeries);
 * otherwise falls back to `instanceNumber` ascending. A genuinely
 * inconsistent series (dimension mismatch, or orientation that disagrees
 * across slices in either path) throws InconsistentSeriesError.
 */
export function assembleSeries(
  wasm: ImageParser,
  files: Uint8Array[],
  volumeId: string,
): {
  sliceMessages: HuSliceMessage[];
  volume: VolumeReadyMessage;
  nativeVolume: NativeVolumeReadyMessage;
  orderingMethod: OrderingMethod;
} {
  if (files.length === 0) {
    throw new InconsistentSeriesError("no files provided");
  }

  const rawParsed = files.map((f) => parseSliceRaw(wasm, f));
  const allHaveOrientationTags = rawParsed.every(
    (raw) => raw.image.hasImageOrientationPatient && raw.image.hasImagePositionPatient,
  );

  if (!allHaveOrientationTags) {
    return assembleFallbackOrderedSeries(rawParsed, volumeId);
  }

  try {
    return assembleAxisAlignedSeries(rawParsed, volumeId);
  } catch (error) {
    if (!(error instanceof UnsupportedOrientationError)) {
      throw error;
    }
    console.warn(
      "parse-worker: series is not axis-aligned (oblique acquisition) -- " +
        "falling back to whole-series trilinear resampling instead of rejecting it",
    );
    return assembleObliqueSeries(rawParsed, volumeId);
  }
}
