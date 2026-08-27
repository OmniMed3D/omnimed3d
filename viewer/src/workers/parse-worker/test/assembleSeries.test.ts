import { describe, expect, it } from "vitest";
import type { DicomWasmImageInfo, ImageParser } from "../src/wasm.js";
import { assembleSeries, InconsistentSeriesError } from "../src/pipeline.js";
import { float32ToFloat16 } from "../src/halfFloat.js";

/**
 * assembleSeries's own job (sorting, dimension-consistency checking,
 * concatenation) is what's under test here -- not DICOM parsing itself
 * (already verified against real WASM output + real file bytes in
 * pipeline.test.ts) or half-float conversion correctness (already
 * verified against independently hand-derived bit patterns in
 * halfFloat.test.ts). So these fakes are fully synthetic, with
 * hand-verifiable HU/half-float values chosen specifically to make the
 * expected bit patterns easy to check by hand:
 *   raw=1 -> HU=1.0 -> half-float 0x3C00
 *   raw=2 -> HU=2.0 -> half-float 0x4000
 *   raw=4 -> HU=4.0 -> half-float 0x4400
 * (rescaleSlope=1, rescaleIntercept=0 for all three fakes below.)
 *
 * `orientation`/`position` default to absent (matching the pre-issue-#21
 * fixtures, which predate orientation support) so existing callers keep
 * exercising the instanceNumber fallback path unless a test opts in.
 */
function makeFakeSlice(
  rawValue: number,
  instanceNumber: number,
  rows = 2,
  columns = 2,
  orientation?: { row: [number, number, number]; column: [number, number, number] },
  position?: [number, number, number],
  windowLevel?: { center: number; width: number },
  modality = "",
): DicomWasmImageInfo {
  const pixelCount = rows * columns;
  const raw = new Int16Array(pixelCount).fill(rawValue);
  return {
    rows,
    columns,
    bitsAllocated: 16,
    pixelRepresentation: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    pixelSpacingRow: 0.5,
    pixelSpacingColumn: 0.6,
    sliceThickness: 2,
    instanceNumber,
    imageOrientationPatient: (orientation
      ? [...orientation.row, ...orientation.column]
      : [1, 0, 0, 0, 1, 0]) as DicomWasmImageInfo["imageOrientationPatient"],
    imagePositionPatient: position ?? [0, 0, 0],
    hasImageOrientationPatient: orientation !== undefined,
    hasImagePositionPatient: position !== undefined,
    windowCenter: windowLevel?.center ?? 0,
    windowWidth: windowLevel?.width ?? 0,
    hasWindowCenter: windowLevel !== undefined,
    hasWindowWidth: windowLevel !== undefined,
    modality,
    pixelData: new Uint8Array(raw.buffer),
  };
}

/** Like makeFakeSlice, but with distinct per-pixel raw values so a reordering transform is actually observable in the output (a uniform-fill slice looks identical whether flipped/transposed or not). */
function makeFakeSliceFromValues(
  values: number[],
  rows: number,
  columns: number,
  orientation: { row: [number, number, number]; column: [number, number, number] },
  position: [number, number, number] = [0, 0, 0],
): DicomWasmImageInfo {
  const raw = new Int16Array(values);
  return {
    rows,
    columns,
    bitsAllocated: 16,
    pixelRepresentation: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    pixelSpacingRow: 0.5,
    pixelSpacingColumn: 0.6,
    sliceThickness: 2,
    instanceNumber: 1,
    imageOrientationPatient: [
      ...orientation.row,
      ...orientation.column,
    ] as DicomWasmImageInfo["imageOrientationPatient"],
    imagePositionPatient: position,
    hasImageOrientationPatient: true,
    hasImagePositionPatient: true,
    windowCenter: 0,
    windowWidth: 0,
    hasWindowCenter: false,
    hasWindowWidth: false,
    modality: "",
    pixelData: new Uint8Array(raw.buffer),
  };
}

function fakeParserFor(slices: DicomWasmImageInfo[]): ImageParser {
  let i = 0;
  return {
    parseImage: () => {
      const slice = slices[i];
      i++;
      if (!slice) {
        throw new Error("fakeParserFor called more times than slices provided");
      }
      return slice;
    },
  };
}

describe("assembleSeries", () => {
  it("sorts slices by instanceNumber and assembles both hu-slice and volume-ready outputs in that order", () => {
    // Fed to assembleSeries in file order [instanceNumber=3, 1, 2] --
    // deliberately out of order, so a passing test proves sorting happened.
    const sliceA = makeFakeSlice(1, 3); // HU=1 -> 0x3C00
    const sliceB = makeFakeSlice(2, 1); // HU=2 -> 0x4000
    const sliceC = makeFakeSlice(4, 2); // HU=4 -> 0x4400
    const wasm = fakeParserFor([sliceA, sliceB, sliceC]);

    const { sliceMessages, volume, nativeVolume, orderingMethod } = assembleSeries(
      wasm,
      [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
      "vol-1",
    );

    expect(orderingMethod).toBe("instanceNumber");
    expect(sliceMessages).toHaveLength(3);
    // Ascending instanceNumber order: sliceB(1), sliceC(2), sliceA(3).
    expect(sliceMessages[0]?.sliceIndex).toBe(0);
    expect(sliceMessages[1]?.sliceIndex).toBe(1);
    expect(sliceMessages[2]?.sliceIndex).toBe(2);
    expect(Array.from(new Float32Array(sliceMessages[0]?.data as ArrayBuffer))).toEqual([2, 2, 2, 2]);
    expect(Array.from(new Float32Array(sliceMessages[1]?.data as ArrayBuffer))).toEqual([4, 4, 4, 4]);
    expect(Array.from(new Float32Array(sliceMessages[2]?.data as ArrayBuffer))).toEqual([1, 1, 1, 1]);

    expect(volume.type).toBe("volume-ready");
    expect(volume.volumeId).toBe("vol-1");
    expect(volume.width).toBe(2);
    expect(volume.height).toBe(2);
    expect(volume.depth).toBe(3);
    expect(volume.spacingX).toBe(0.6); // pixelSpacingColumn
    expect(volume.spacingY).toBe(0.5); // pixelSpacingRow
    expect(volume.spacingZ).toBe(2); // sliceThickness
    expect(volume.data.byteLength).toBe(2 * 2 * 3 * 2); // width*height*depth*sizeof(uint16_t)

    const voxels = new Uint16Array(volume.data);
    expect(Array.from(voxels.subarray(0, 4))).toEqual([0x4000, 0x4000, 0x4000, 0x4000]); // depth 0: sliceB
    expect(Array.from(voxels.subarray(4, 8))).toEqual([0x4400, 0x4400, 0x4400, 0x4400]); // depth 1: sliceC
    expect(Array.from(voxels.subarray(8, 12))).toEqual([0x3c00, 0x3c00, 0x3c00, 0x3c00]); // depth 2: sliceA

    // MPR + native-slice feature -- same order/dims as the main volume
    // for this identity-transform case (no orientation tags,
    // so nothing to normalize); the two paths only actually diverge in
    // pixel data when a real flip/transpose happens, see the dedicated
    // test below.
    expect(nativeVolume.type).toBe("native-volume-ready");
    expect(nativeVolume.width).toBe(2);
    expect(nativeVolume.height).toBe(2);
    expect(nativeVolume.depth).toBe(3);
    const nativeVoxels = new Uint16Array(nativeVolume.data);
    expect(Array.from(nativeVoxels.subarray(0, 4))).toEqual([0x4000, 0x4000, 0x4000, 0x4000]);
    expect(Array.from(nativeVoxels.subarray(4, 8))).toEqual([0x4400, 0x4400, 0x4400, 0x4400]);
    expect(Array.from(nativeVoxels.subarray(8, 12))).toEqual([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
  });

  it("rejects a series with inconsistent slice dimensions", () => {
    const sliceA = makeFakeSlice(1, 1, 2, 2);
    const sliceB = makeFakeSlice(1, 2, 4, 4);
    const wasm = fakeParserFor([sliceA, sliceB]);

    expect(() => assembleSeries(wasm, [new Uint8Array(0), new Uint8Array(0)], "v")).toThrow(InconsistentSeriesError);
  });

  it("rejects an empty file list", () => {
    const wasm = fakeParserFor([]);
    expect(() => assembleSeries(wasm, [], "v")).toThrow(InconsistentSeriesError);
  });

  // For non-HU data (e.g. MR), where a CT Hounsfield-Unit preset would
  // blow the image out, the file's own VOI LUT window (WindowCenter/
  // WindowWidth, DICOM PS3.3 C.11.2) is the only reliable display hint.
  // assembleSeries takes it from the first slice, same pattern as
  // spacingZ/sliceThickness.
  it("carries the first slice's WindowCenter/WindowWidth into the volume-ready message when present", () => {
    const sliceA = makeFakeSlice(1, 1, 2, 2, undefined, undefined, { center: 212, width: 493 });
    const wasm = fakeParserFor([sliceA]);

    const { volume } = assembleSeries(wasm, [new Uint8Array(0)], "v");

    expect(volume.windowCenter).toBe(212);
    expect(volume.windowWidth).toBe(493);
  });

  it("leaves windowCenter/windowWidth undefined when the file carries no VOI LUT window", () => {
    const sliceA = makeFakeSlice(1, 1, 2, 2);
    const wasm = fakeParserFor([sliceA]);

    const { volume } = assembleSeries(wasm, [new Uint8Array(0)], "v");

    expect(volume.windowCenter).toBeUndefined();
    expect(volume.windowWidth).toBeUndefined();
  });

  // "Does this file carry a VOI LUT window" is a bad proxy for "is this
  // non-HU data" -- real CT commonly carries one too. Modality is the
  // signal the Shell needs, carried through the same "first slice"
  // pattern as windowCenter/windowWidth above.
  it("carries the first slice's Modality into the volume-ready message when present", () => {
    const sliceA = makeFakeSlice(1, 1, 2, 2, undefined, undefined, undefined, "MR");
    const wasm = fakeParserFor([sliceA]);

    const { volume } = assembleSeries(wasm, [new Uint8Array(0)], "v");

    expect(volume.modality).toBe("MR");
  });

  it("leaves modality undefined when the file carries no Modality tag", () => {
    const sliceA = makeFakeSlice(1, 1, 2, 2);
    const wasm = fakeParserFor([sliceA]);

    const { volume } = assembleSeries(wasm, [new Uint8Array(0)], "v");

    expect(volume.modality).toBeUndefined();
  });

  it("orders slices geometrically by ImagePositionPatient when every slice has orientation/position, overriding instanceNumber", () => {
    const CANONICAL: { row: [number, number, number]; column: [number, number, number] } = {
      row: [1, 0, 0],
      column: [0, 1, 0],
    };
    // instanceNumber order is [1, 2, 3] but z-position order is [B, C, A] --
    // a passing test proves geometric position won the tie-break, not instanceNumber.
    const sliceA = makeFakeSlice(1, 1, 2, 2, CANONICAL, [0, 0, 20]); // HU=1 -> 0x3C00, z=20 (last)
    const sliceB = makeFakeSlice(2, 2, 2, 2, CANONICAL, [0, 0, -20]); // HU=2 -> 0x4000, z=-20 (first)
    const sliceC = makeFakeSlice(4, 3, 2, 2, CANONICAL, [0, 0, 0]); // HU=4 -> 0x4400, z=0 (middle)
    const wasm = fakeParserFor([sliceA, sliceB, sliceC]);

    const { sliceMessages, orderingMethod } = assembleSeries(
      wasm,
      [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
      "vol-1",
    );

    expect(orderingMethod).toBe("geometric");
    expect(Array.from(new Float32Array(sliceMessages[0]?.data as ArrayBuffer))).toEqual([2, 2, 2, 2]); // sliceB, z=-20
    expect(Array.from(new Float32Array(sliceMessages[1]?.data as ArrayBuffer))).toEqual([4, 4, 4, 4]); // sliceC, z=0
    expect(Array.from(new Float32Array(sliceMessages[2]?.data as ArrayBuffer))).toEqual([1, 1, 1, 1]); // sliceA, z=20
  });

  it("rejects a series whose slices have mutually inconsistent orientation", () => {
    const sliceA = makeFakeSlice(1, 1, 2, 2, { row: [1, 0, 0], column: [0, 1, 0] }, [0, 0, 0]);
    const sliceB = makeFakeSlice(1, 2, 2, 2, { row: [-1, 0, 0], column: [0, -1, 0] }, [0, 0, 1]);
    const wasm = fakeParserFor([sliceA, sliceB]);

    expect(() => assembleSeries(wasm, [new Uint8Array(0), new Uint8Array(0)], "v")).toThrow(InconsistentSeriesError);
  });

  it("normalizes a flipped (180-degree) orientation's pixel data before assembling", () => {
    // rowCosine=[-1,0,0], columnCosine=[0,-1,0]: both in-plane axes flipped
    // relative to canonical, no transpose -- output should be the 180-degree
    // rotation of the input grid.
    const flipped = makeFakeSliceFromValues([1, 2, 3, 4, 5, 6], 2, 3, { row: [-1, 0, 0], column: [0, -1, 0] });
    const wasm = fakeParserFor([flipped]);

    const { sliceMessages, volume, nativeVolume } = assembleSeries(wasm, [new Uint8Array(0)], "v");

    expect(sliceMessages[0]?.width).toBe(3);
    expect(sliceMessages[0]?.height).toBe(2);
    expect(Array.from(new Float32Array(sliceMessages[0]?.data as ArrayBuffer))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(volume.width).toBe(3);
    expect(volume.height).toBe(2);
    expect(volume.spacingX).toBe(0.6); // pixelSpacingColumn, unaffected by flips (only transpose swaps these)
    expect(volume.spacingY).toBe(0.5); // pixelSpacingRow

    // MPR + native-slice feature -- nativeVolume is the literal source
    // pixel data, untouched by the 180-degree flip
    // `volume`/`sliceMessages` normalize away. This is the case that
    // actually distinguishes the two (the identity-transform test above
    // can't, since there's nothing to normalize there).
    expect(nativeVolume.width).toBe(3);
    expect(nativeVolume.height).toBe(2);
    expect(Array.from(new Uint16Array(nativeVolume.data))).toEqual([1, 2, 3, 4, 5, 6].map((v) => float32ToFloat16(v)));
  });

  it("normalizes a transposed orientation's pixel data and dimensions/spacing before assembling", () => {
    // rowCosine=[0,1,0], columnCosine=[1,0,0]: row/column axes swapped
    // relative to canonical -- output grid is the transpose of the input,
    // with dimensions and row/column spacing swapped to match.
    const transposed = makeFakeSliceFromValues([1, 2, 3, 4, 5, 6], 2, 3, { row: [0, 1, 0], column: [1, 0, 0] });
    const wasm = fakeParserFor([transposed]);

    const { sliceMessages, volume } = assembleSeries(wasm, [new Uint8Array(0)], "v");

    expect(sliceMessages[0]?.width).toBe(2);
    expect(sliceMessages[0]?.height).toBe(3);
    expect(Array.from(new Float32Array(sliceMessages[0]?.data as ArrayBuffer))).toEqual([1, 4, 2, 5, 3, 6]);
    expect(volume.width).toBe(2);
    expect(volume.height).toBe(3);
    expect(volume.spacingX).toBe(0.5); // pixelSpacingRow -- swapped in because of the transpose
    expect(volume.spacingY).toBe(0.6); // pixelSpacingColumn
  });

  // Oblique-resample fallback: real neuro MR is routinely angled a few to
  // ~20 degrees off axial, which computeOrientationTransform's
  // axis-aligned-only fast path rejects. A 30-degree in-plane rotation
  // about Z (row/column cosines rotated, slice normal stays exactly Z) --
  // same geometry checked in orientation.test.ts's
  // computeObliqueResampleGrid tests.
  describe("oblique acquisitions", () => {
    const COS30 = Math.sqrt(3) / 2;
    const SIN30 = 0.5;
    const OBLIQUE: { row: [number, number, number]; column: [number, number, number] } = {
      row: [COS30, SIN30, 0],
      column: [-SIN30, COS30, 0],
    };

    it("resamples an oblique series onto a canonical grid instead of rejecting it", () => {
      const UNIFORM_HU = 5; // rawValue=5, rescaleSlope=1/intercept=0 (makeFakeSlice's default)
      const sliceSpacing = 2;
      const slices = [0, 1, 2].map((z) => makeFakeSlice(UNIFORM_HU, z + 1, 4, 4, OBLIQUE, [0, 0, z * sliceSpacing]));
      const wasm = fakeParserFor(slices);

      const { sliceMessages, volume, nativeVolume, orderingMethod } = assembleSeries(
        wasm,
        slices.map(() => new Uint8Array(0)),
        "vol-oblique",
      );

      expect(orderingMethod).toBe("oblique-resample");

      // Hand-verified bounding box for a 4x4x3 stack rotated 30 degrees
      // about Z, using makeFakeSlice's fixed pixelSpacingColumn=0.6/
      // pixelSpacingRow=0.5 and sliceSpacing=2 -- grid dims are the
      // physical extent divided by the *output* spacing (not 1), then
      // round()+1: X extent = 1.55884572 - (-0.75) = 2.30884572, /0.6 =
      // 3.8480762 -> round()+1 = 5; Y extent = 2.1990381, /0.5 = 4.3980762
      // -> round()+1 = 5; Z extent = 2*2 = 4, /2 = 2 -> round()+1 = 3.
      expect(volume.width).toBe(5);
      expect(volume.height).toBe(5);
      expect(volume.depth).toBe(3);
      expect(volume.spacingX).toBe(0.6); // pixelSpacingColumn, unrotated magnitude
      expect(volume.spacingY).toBe(0.5); // pixelSpacingRow, unrotated magnitude
      expect(volume.spacingZ).toBeCloseTo(sliceSpacing, 6); // derived via dot-product subtraction, tiny float error expected
      expect(sliceMessages).toHaveLength(3);

      // The source stack is uniformly UNIFORM_HU everywhere -- any output
      // voxel whose trilinear neighborhood stays fully inside the source
      // bounding box reproduces that exact value untouched. If resampling
      // were broken (e.g. producing all-zero output), no output voxel
      // would ever hit this exact value.
      const middleSlice = new Float32Array(sliceMessages[1]?.data as ArrayBuffer);
      expect(Math.max(...middleSlice)).toBe(UNIFORM_HU);

      // MPR + native-slice feature -- nativeVolume is the pre-resampling
      // source stack (4x4x3, native acquisition order/
      // resolution), entirely unlike volume's reformatted 5x5x3 grid.
      expect(nativeVolume.width).toBe(4);
      expect(nativeVolume.height).toBe(4);
      expect(nativeVolume.depth).toBe(3);
      const nativeVoxels = new Uint16Array(nativeVolume.data);
      expect(nativeVoxels.length).toBe(4 * 4 * 3);
      expect(Array.from(nativeVoxels)).toEqual(new Array(4 * 4 * 3).fill(float32ToFloat16(UNIFORM_HU)));
    });

    it("rejects an oblique series whose slices have mutually inconsistent orientation", () => {
      const sliceA = makeFakeSlice(1, 1, 4, 4, OBLIQUE, [0, 0, 0]);
      const rotatedDifferently: { row: [number, number, number]; column: [number, number, number] } = {
        row: [0, 1, 0], // 90 degrees further than OBLIQUE
        column: [-1, 0, 0],
      };
      // Individually axis-aligned, but inconsistent with sliceA's oblique
      // orientation -- assembleAxisAlignedSeries's own per-slice
      // classification would throw UnsupportedOrientationError on sliceA
      // first, routing the whole series into assembleObliqueSeries, whose
      // own cross-slice consistency check must then catch the mismatch.
      const sliceB = makeFakeSlice(1, 2, 4, 4, rotatedDifferently, [0, 0, 2]);
      const wasm = fakeParserFor([sliceA, sliceB]);

      expect(() => assembleSeries(wasm, [new Uint8Array(0), new Uint8Array(0)], "v")).toThrow(InconsistentSeriesError);
    });
  });
});
