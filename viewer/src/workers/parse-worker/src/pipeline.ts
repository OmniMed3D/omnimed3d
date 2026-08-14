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
 * silently miscomputing. Multi-file ordering uses `instanceNumber` only
 * (not `ImagePositionPatient`-based geometric ordering) -- adequate for a
 * typical single-series acquisition, not a substitute for true geometric
 * sorting; see dicom-parser/README.md's `DicomImageInfo.instanceNumber` entry.
 */
import type { DicomWasmImageInfo, ImageParser } from "./wasm.js";
import { float32ToFloat16 } from "./halfFloat.js";

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

  return { image, hu };
}

export function parseSliceToHu(
  wasm: ImageParser,
  fileBytes: Uint8Array,
  volumeId: string,
  sliceIndex: number,
): HuSliceMessage {
  const { image, hu } = parseSliceHu(wasm, fileBytes);
  return {
    type: "hu-slice",
    volumeId,
    sliceIndex,
    width: image.columns,
    height: image.rows,
    data: hu.buffer as ArrayBuffer,
  };
}

/**
 * Parses every file in `files` exactly once, orders them by
 * `instanceNumber` ascending, and produces both the per-slice `hu-slice`
 * messages (Inference Worker leg) and one assembled `volume-ready`
 * message (rendering-engine leg) from that single pass.
 */
export function assembleSeries(
  wasm: ImageParser,
  files: Uint8Array[],
  volumeId: string,
): { sliceMessages: HuSliceMessage[]; volume: VolumeReadyMessage } {
  if (files.length === 0) {
    throw new InconsistentSeriesError("no files provided");
  }

  const parsed = files.map((f) => parseSliceHu(wasm, f));
  parsed.sort((a, b) => a.image.instanceNumber - b.image.instanceNumber);

  const first = parsed[0] as ParsedSlice;
  const { rows, columns } = first.image;
  for (const slice of parsed) {
    if (slice.image.rows !== rows || slice.image.columns !== columns) {
      throw new InconsistentSeriesError(
        `slice dimensions vary across the series (expected ${rows}x${columns}, ` +
          `got ${slice.image.rows}x${slice.image.columns})`,
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
    spacingX: first.image.pixelSpacingColumn,
    spacingY: first.image.pixelSpacingRow,
    spacingZ: first.image.sliceThickness,
    data: volumeData.buffer as ArrayBuffer,
  };

  return { sliceMessages, volume };
}
