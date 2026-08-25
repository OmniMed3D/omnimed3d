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
  it("passes the real probe result through when no debug override and not WebKit", () => {
    expect(resolveEffectiveGpuDetected(undefined, true, false)).toBe(true);
    expect(resolveEffectiveGpuDetected(undefined, false, false)).toBe(false);
  });

  it("forces false when WebKit, regardless of a real adapter being detected", () => {
    expect(resolveEffectiveGpuDetected(undefined, true, true)).toBe(false);
    expect(resolveEffectiveGpuDetected(undefined, false, true)).toBe(false);
  });

  it("forces true for gpu-fp16 regardless of the real probe result or WebKit", () => {
    expect(resolveEffectiveGpuDetected("gpu-fp16", false, false)).toBe(true);
    expect(resolveEffectiveGpuDetected("gpu-fp16", true, false)).toBe(true);
    expect(resolveEffectiveGpuDetected("gpu-fp16", false, true)).toBe(true);
  });

  it("forces false for wasm-int8 regardless of the real probe result or WebKit", () => {
    expect(resolveEffectiveGpuDetected("wasm-int8", true, false)).toBe(false);
    expect(resolveEffectiveGpuDetected("wasm-int8", false, false)).toBe(false);
    expect(resolveEffectiveGpuDetected("wasm-int8", true, true)).toBe(false);
  });
});
