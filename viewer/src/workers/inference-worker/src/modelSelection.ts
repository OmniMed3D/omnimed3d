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
