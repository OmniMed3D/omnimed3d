import { beforeAll, describe, expect, it } from "vitest";
import { DicomParserWasm, type DicomWasmImageInfo, type ImageParser } from "../src/wasm.js";
import { assembleSeries, parseSliceToHu, UnsupportedPixelDataError } from "../src/pipeline.js";
import { loadCtSmallDcm, WASM_MODULE_URL } from "./fixtures.js";

// Ground truth for CT_small.dcm, established earlier this session by
// dumping the file's actual bytes directly (dicom-parser's own CTest
// suite asserts the same values -- see dicom-parser/tests/DicomFileTest.cpp).
const ROWS = 128;
const COLUMNS = 128;
const RESCALE_SLOPE = 1;
const RESCALE_INTERCEPT = -1024;
const PIXEL_DATA_OFFSET_IN_FILE = 6300;

describe("parseSliceToHu vs CT_small.dcm ground truth", () => {
  let wasm: DicomParserWasm;

  beforeAll(async () => {
    wasm = await DicomParserWasm.load(WASM_MODULE_URL);
  });

  it("produces an hu-slice message matching the fixture's known geometry", () => {
    const fileBytes = loadCtSmallDcm();
    const message = parseSliceToHu(wasm, fileBytes, "test-volume", 0);

    expect(message.type).toBe("hu-slice");
    expect(message.volumeId).toBe("test-volume");
    expect(message.sliceIndex).toBe(0);
    expect(message.width).toBe(COLUMNS);
    expect(message.height).toBe(ROWS);
    expect(message.data.byteLength).toBe(ROWS * COLUMNS * 4);
  });

  it("computes HU = raw * rescaleSlope + rescaleIntercept, checked independently from the raw file bytes", () => {
    const fileBytes = loadCtSmallDcm();
    const message = parseSliceToHu(wasm, fileBytes, "test-volume", 0);
    const hu = new Float32Array(message.data);

    // Independently re-reads the signed 16-bit pixel data straight out of
    // the file buffer at the known offset -- not derived from pipeline.ts's
    // own logic, so a bug in the HU formula can't pass by agreeing with itself.
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset + PIXEL_DATA_OFFSET_IN_FILE, ROWS * COLUMNS * 2);

    for (const i of [0, 1, 100, 5000, ROWS * COLUMNS - 1]) {
      const raw = view.getInt16(i * 2, true);
      const expectedHu = raw * RESCALE_SLOPE + RESCALE_INTERCEPT;
      expect(hu[i]).toBeCloseTo(expectedHu, 4);
    }
  });

  it("passes real (already-canonical) orientation data through unchanged and orders via assembleSeries geometrically", () => {
    // CT_small.dcm's real ImageOrientationPatient ([1,0,0, 0,1,0]) is
    // already the canonical convention -- ground truth dumped directly
    // from the file's bytes, same as dicom-parser/tests/DicomFileTest.cpp.
    // A single-file "series" still exercises assembleSeries's geometric
    // path (it has both orientation and position tags) without needing a
    // second real fixture file.
    const fileBytes = loadCtSmallDcm();
    const { sliceMessages, volume, orderingMethod } = assembleSeries(wasm, [fileBytes], "test-volume");

    expect(orderingMethod).toBe("geometric");
    expect(sliceMessages[0]?.width).toBe(COLUMNS);
    expect(sliceMessages[0]?.height).toBe(ROWS);
    expect(volume.width).toBe(COLUMNS);
    expect(volume.height).toBe(ROWS);
    expect(volume.depth).toBe(1);

    // Identity transform -- same HU values as the direct parseSliceToHu path.
    const direct = parseSliceToHu(wasm, fileBytes, "test-volume", 0);
    expect(Array.from(new Float32Array(sliceMessages[0]?.data as ArrayBuffer))).toEqual(
      Array.from(new Float32Array(direct.data)),
    );
  });

  it("rejects pixel data that isn't 16-bit instead of silently miscomputing", () => {
    const fakeImage: DicomWasmImageInfo = {
      rows: 4,
      columns: 4,
      bitsAllocated: 8,
      pixelRepresentation: 0,
      rescaleSlope: 1,
      rescaleIntercept: 0,
      pixelSpacingRow: 1,
      pixelSpacingColumn: 1,
      sliceThickness: 1,
      instanceNumber: 1,
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      imagePositionPatient: [0, 0, 0],
      hasImageOrientationPatient: false,
      hasImagePositionPatient: false,
      windowCenter: 0,
      windowWidth: 0,
      hasWindowCenter: false,
      hasWindowWidth: false,
      pixelData: new Uint8Array(16),
    };
    const fakeParser: ImageParser = { parseImage: () => fakeImage };

    expect(() => parseSliceToHu(fakeParser, new Uint8Array(0), "v", 0)).toThrow(UnsupportedPixelDataError);
  });
});
