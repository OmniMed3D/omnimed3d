import { describe, expect, it } from "vitest";
import { lungmaskPreprocess, simpleBodymask } from "../src/adapters/lungmask/preprocess.js";
import { loadFloat32Bin, loadManifest } from "./fixtures.js";

describe("lungmask preprocess vs Python reference", () => {
  const manifest = loadManifest();

  it("has fixtures to test against", () => {
    expect(manifest.length).toBeGreaterThan(0);
  });

  for (const entry of loadManifest()) {
    it(`body mask bbox matches for ${entry.stem}`, () => {
      const hu = loadFloat32Bin(entry.stem, "hu");
      const clipped = Float32Array.from(hu, (v) => Math.min(Math.max(v, -1024), 600));
      const bmask = simpleBodymask({ data: clipped, height: entry.originalHeight, width: entry.originalWidth });

      let minRow = Infinity;
      let minCol = Infinity;
      let maxRow = -Infinity;
      let maxCol = -Infinity;
      for (let y = 0; y < entry.originalHeight; y++) {
        for (let x = 0; x < entry.originalWidth; x++) {
          if (bmask.data[y * entry.originalWidth + x] === 1) {
            if (y < minRow) minRow = y;
            if (y > maxRow) maxRow = y;
            if (x < minCol) minCol = x;
            if (x > maxCol) maxCol = x;
          }
        }
      }
      const bbox = [minRow, minCol, maxRow + 1, maxCol + 1];
      expect(bbox).toEqual(entry.bodyMaskBbox);
    });

    it(`preprocessed tensor matches for ${entry.stem}`, () => {
      const hu = loadFloat32Bin(entry.stem, "hu");
      const reference = loadFloat32Bin(entry.stem, "preprocessed");

      const tensor = lungmaskPreprocess({ data: hu, width: entry.originalWidth, height: entry.originalHeight });
      const actual = tensor.data as Float32Array;

      expect(actual.length).toBe(reference.length);
      let maxAbsDiff = 0;
      for (let i = 0; i < actual.length; i++) {
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(actual[i]! - reference[i]!));
      }
      expect(maxAbsDiff).toBeLessThan(1e-3);
    });
  }
});
