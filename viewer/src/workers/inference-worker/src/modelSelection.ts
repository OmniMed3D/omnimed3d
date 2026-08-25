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
 * Resolves the effective "should this session use WebGPU" boolean that
 * model/EP/import selection should use. Precedence: a debug override (if
 * set) wins outright -- including on a real WebKit device, since forcing
 * "gpu-fp16" there on purpose (to reproduce the crash/slowdown for
 * verification) is a legitimate use of the override. Otherwise, WebKit
 * (see environment.ts's isWebKitForced()) always means no WebGPU,
 * regardless of whether a real adapter was detected -- the bug this
 * exists to avoid isn't a capability gap, so a WebKit device with a
 * working WebGPU adapter still needs to be routed away from it. Pure so
 * it's unit-testable without a real `navigator.gpu`/`navigator.userAgent`
 * or postMessage.
 */
export function resolveEffectiveGpuDetected(
  debugForce: DebugForce | undefined,
  gpuDetected: boolean,
  isWebKitForced: boolean,
): boolean {
  if (debugForce !== undefined) return debugForce === "gpu-fp16";
  return gpuDetected && !isWebKitForced;
}
