import { describe, expect, it } from "vitest";
import type { DicomWasmImageInfo, ImageParser } from "../src/wasm.js";
import { assembleSeries, InconsistentSeriesError } from "../src/pipeline.js";

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
 */
function makeFakeSlice(rawValue: number, instanceNumber: number, rows = 2, columns = 2): DicomWasmImageInfo {
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

    const { sliceMessages, volume } = assembleSeries(
      wasm,
      [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
      "vol-1",
    );

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
});
