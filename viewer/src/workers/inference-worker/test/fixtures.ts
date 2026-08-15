import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../../../..");
export const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "ai-pipeline",
  "quantization",
  "calibration_data",
  "inference_fixtures",
);
export const ONNX_MODEL_PATH = path.join(
  REPO_ROOT,
  "ai-pipeline",
  "conversion",
  "adapters",
  "lungmask",
  "lungmask_r231.onnx",
);

const QUANTIZATION_DIR = path.join(REPO_ROOT, "ai-pipeline", "quantization");
export const ONNX_MODEL_PATH_INT8 = path.join(QUANTIZATION_DIR, "lungmask_r231_int8.onnx");
export const ONNX_MODEL_PATH_FP16 = path.join(QUANTIZATION_DIR, "lungmask_r231_fp16.onnx");

export interface FixtureManifestEntry {
  stem: string;
  originalHeight: number;
  originalWidth: number;
  bodyMaskBbox: [number, number, number, number];
  argmaxClassCounts: Record<string, number>;
}

export function loadManifest(): FixtureManifestEntry[] {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf-8"));
}

export function loadFloat32Bin(stem: string, suffix: string): Float32Array {
  const buf = readFileSync(path.join(FIXTURES_DIR, `${stem}_${suffix}.bin`));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function loadUint8Bin(stem: string, suffix: string): Uint8Array {
  const buf = readFileSync(path.join(FIXTURES_DIR, `${stem}_${suffix}.bin`));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
