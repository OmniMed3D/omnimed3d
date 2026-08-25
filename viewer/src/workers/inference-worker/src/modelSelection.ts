/**
 * Picks which quantized model variant to load based on whether a WebGPU
 * adapter is available (Issue #35, docs/verification/inference-worker.md
 * §8.4): FP16 is fastest on WebGPU (~160-210ms warm infer), while INT8 --
 * fastest on WASM -- is the slowest of the three on WebGPU, because
 * WebGPU's JSEP backend has no QuantizeLinear kernel and all 117 of INT8's
 * quantize nodes fall back to WASM per-node (§8.3).
 *
 * A pure function so the selection rule itself is unit-testable without a
 * real `navigator.gpu` -- worker.ts owns the actual detection.
 */
export function resolveModelPath(basePath: string, hasGpu: boolean): string {
  return `${basePath}${hasGpu ? "_fp16" : "_int8"}.onnx`;
}

/** Debug-only override of which inference path to use, bypassing the real
 * `navigator.gpu` probe -- lets a caller (Shell's `?aiForce=` URL param,
 * see worker.ts's `InitMessage.debugForce`) reproduce either path without
 * needing hardware that actually matches it, e.g. simulating the
 * WASM-only path used to work around the iOS/WebKit onnxruntime-web bug
 * on a desktop that has a working WebGPU adapter. */
export type DebugForce = "wasm-int8" | "gpu-fp16";

/**
 * Resolves the effective "was a WebGPU adapter detected" boolean that
 * model/EP selection should use: the real probe result, unless a debug
 * override replaces it outright. Pure so it's unit-testable without a
 * real `navigator.gpu` or postMessage.
 */
export function resolveEffectiveGpuDetected(
  debugForce: DebugForce | undefined,
  gpuDetected: boolean,
): boolean {
  if (debugForce === undefined) return gpuDetected;
  return debugForce === "gpu-fp16";
}
