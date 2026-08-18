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
  computeOrientationTransform,
  dot,
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

function parseSliceHu(wasm: ImageParser, fileBytes: Uint8Array): ParsedSlice {
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

/**
 * Parses every file in `files` exactly once and produces both the
 * per-slice `hu-slice` messages (Inference Worker leg) and one assembled
 * `volume-ready` message (rendering-engine leg) from that single pass.
 *
 * Ordering: geometric (projecting ImagePositionPatient onto the slice
 * normal) when every slice has orientation/position and they're mutually
 * consistent; otherwise falls back to `instanceNumber` ascending, with a
 * `console.warn` either for the fallback itself or for a genuinely
 * inconsistent series (thrown as InconsistentSeriesError, same as a
 * dimension mismatch).
 */
export function assembleSeries(
  wasm: ImageParser,
  files: Uint8Array[],
  volumeId: string,
): { sliceMessages: HuSliceMessage[]; volume: VolumeReadyMessage; orderingMethod: "geometric" | "instanceNumber" } {
  if (files.length === 0) {
    throw new InconsistentSeriesError("no files provided");
  }

  const parsed = files.map((f) => parseSliceHu(wasm, f));

  const allHaveOrientation = parsed.every((slice) => slice.orientation !== null);
  let orderingMethod: "geometric" | "instanceNumber";
  if (allHaveOrientation) {
    const first = parsed[0]!.orientation as OrientationTransform;
    for (const slice of parsed) {
      if (!orientationsConsistent(first, slice.orientation as OrientationTransform)) {
        throw new InconsistentSeriesError(
          "slice orientation varies across the series (row/column direction cosines don't agree)",
        );
      }
    }
    orderingMethod = "geometric";
    parsed.sort((a, b) => geometricSortKey(a) - geometricSortKey(b));
  } else {
    console.warn(
      "parse-worker: not every slice has ImageOrientationPatient/ImagePositionPatient -- " +
        "falling back to instanceNumber ordering instead of geometric",
    );
    orderingMethod = "instanceNumber";
    parsed.sort((a, b) => a.image.instanceNumber - b.image.instanceNumber);
  }

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
  };

  return { sliceMessages, volume, orderingMethod };
}
