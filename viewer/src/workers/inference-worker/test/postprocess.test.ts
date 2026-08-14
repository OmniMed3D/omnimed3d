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

    const out = lungmaskPostprocess(logits, { width: 4, height: 4 });

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

    const out = lungmaskPostprocess(logits, { width: 512, height: 512 });
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(numClasses);
    }
  });
});
