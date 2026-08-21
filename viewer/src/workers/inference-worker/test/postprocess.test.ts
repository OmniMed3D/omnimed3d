import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { lungmaskPostprocess } from "../src/adapters/lungmask/postprocess.js";

describe("lungmask postprocess (REQ-A17)", () => {
  it("argmaxes classes and Nearest-Neighbor upscales to original resolution", () => {
    // 1x2x2x2 logits: class 1 wins at (0,0) and (1,1), class 0 elsewhere.
    const logits = new ort.Tensor(
      "float32",
      Float32Array.from([
        // class 0
        5, 0, 0, 5,
        // class 1
        0, 5, 5, 0,
      ]),
      [1, 2, 2, 2],
    );

    // Full-frame bbox (no crop) -- isolates the bare upscale behavior from
    // the crop-restore logic, which has its own dedicated test below.
    const out = lungmaskPostprocess(logits, { minRow: 0, minCol: 0, maxRow: 4, maxCol: 4 }, { width: 4, height: 4 });

    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(16);
    // Nearest-neighbor 2x2 -> 4x4 should replicate each source pixel into a 2x2 block.
    expect(Array.from(out)).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0]);
  });

  it("never produces a class index outside [0, numClasses)", () => {
    const numClasses = 3;
    const spatial = 256 * 256;
    const raw = new Float32Array(numClasses * spatial);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.random();
    const logits = new ort.Tensor("float32", raw, [1, numClasses, 256, 256]);

    const out = lungmaskPostprocess(
      logits,
      { minRow: 0, minCol: 0, maxRow: 512, maxCol: 512 },
      { width: 512, height: 512 },
    );
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(numClasses);
    }
  });

  it("restores a non-full-frame crop at its original offset/size, background elsewhere (REQ-C01 alignment)", () => {
    // 1x1x2x2 logits, entirely class 1 -- the model's native output for a
    // slice that was cropped to a sub-region before resizing to 256x256.
    const logits = new ort.Tensor("float32", Float32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), [1, 2, 2, 2]);

    // Crop was rows [2,6), cols [3,7) of a 10x10 original slice -- smaller
    // than the full frame, not starting at the origin.
    const out = lungmaskPostprocess(logits, { minRow: 2, minCol: 3, maxRow: 6, maxCol: 7 }, { width: 10, height: 10 });

    expect(out.length).toBe(100);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const inCrop = y >= 2 && y < 6 && x >= 3 && x < 7;
        expect(out[y * 10 + x], `(row=${y}, col=${x})`).toBe(inCrop ? 1 : 0);
      }
    }
  });
});
