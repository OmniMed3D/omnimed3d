import { describe, expect, it } from "vitest";
import { resolveModelPath } from "../src/modelSelection.js";

describe("resolveModelPath", () => {
  it("picks the FP16 variant when a WebGPU adapter is available", () => {
    expect(resolveModelPath("/models/lungmask_r231", true)).toBe("/models/lungmask_r231_fp16.onnx");
  });

  it("picks the INT8 variant when no WebGPU adapter is available", () => {
    expect(resolveModelPath("/models/lungmask_r231", false)).toBe("/models/lungmask_r231_int8.onnx");
  });
});
