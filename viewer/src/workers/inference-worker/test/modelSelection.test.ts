import { describe, expect, it } from "vitest";
import { resolveEffectiveGpuDetected, resolveModelPath } from "../src/modelSelection.js";

describe("resolveModelPath", () => {
  it("picks the FP16 variant when a WebGPU adapter is available", () => {
    expect(resolveModelPath("/models/lungmask_r231", true)).toBe("/models/lungmask_r231_fp16.onnx");
  });

  it("picks the INT8 variant when no WebGPU adapter is available", () => {
    expect(resolveModelPath("/models/lungmask_r231", false)).toBe("/models/lungmask_r231_int8.onnx");
  });
});

describe("resolveEffectiveGpuDetected", () => {
  it("passes the real probe result through when no debug override is set", () => {
    expect(resolveEffectiveGpuDetected(undefined, true)).toBe(true);
    expect(resolveEffectiveGpuDetected(undefined, false)).toBe(false);
  });

  it("forces true for gpu-fp16 regardless of the real probe result", () => {
    expect(resolveEffectiveGpuDetected("gpu-fp16", false)).toBe(true);
    expect(resolveEffectiveGpuDetected("gpu-fp16", true)).toBe(true);
  });

  it("forces false for wasm-int8 regardless of the real probe result", () => {
    expect(resolveEffectiveGpuDetected("wasm-int8", true)).toBe(false);
    expect(resolveEffectiveGpuDetected("wasm-int8", false)).toBe(false);
  });
});
