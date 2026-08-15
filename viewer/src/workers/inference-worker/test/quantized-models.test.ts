import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import { runSlice } from "../src/pipeline.js";
import { ONNX_MODEL_PATH_FP16, ONNX_MODEL_PATH_INT8, loadFloat32Bin, loadManifest, loadUint8Bin } from "./fixtures.js";

/**
 * Verifies the INT8/FP16 models (Epic 2 PTQ output) actually run through
 * onnxruntime-web's WASM backend end-to-end — this was unverified before
 * (Epic 2's own parity check only ran these through Python onnxruntime, not
 * ORT Web, and quantized-op WASM kernel coverage can differ). Correctness
 * is checked against the same FP32-derived reference mask used by
 * pipeline.test.ts, at a looser tolerance than the FP32-vs-FP32 comparison
 * there, since this compares across both a different model AND a different
 * runtime than the Python reference was generated with.
 */
describe.each([
  { label: "INT8", modelPath: ONNX_MODEL_PATH_INT8, maxMismatchRate: 0.05 },
  { label: "FP16", modelPath: ONNX_MODEL_PATH_FP16, maxMismatchRate: 0.01 },
])("$label model via onnxruntime-web", ({ label, modelPath, maxMismatchRate }) => {
  let session: ort.InferenceSession;
  const adapter = new LungmaskAdapter(modelPath);

  beforeAll(async () => {
    const modelBuffer = readFileSync(modelPath);
    session = await ort.InferenceSession.create(modelBuffer);
  });

  for (const entry of loadManifest()) {
    it(`runs and produces a mask close to the FP32 reference for ${entry.stem}`, async () => {
      const hu = loadFloat32Bin(entry.stem, "hu");
      const referenceMask = loadUint8Bin(entry.stem, "mask");

      const message = await runSlice(adapter, session, {
        volumeId: "test-volume",
        sliceIndex: 0,
        slice: { data: hu, width: entry.originalWidth, height: entry.originalHeight },
      });

      expect(message.data.length).toBe(entry.originalWidth * entry.originalHeight);

      let mismatches = 0;
      for (let i = 0; i < message.data.length; i++) {
        if (message.data[i] !== referenceMask[i]) mismatches++;
      }
      const mismatchRate = mismatches / message.data.length;
      console.log(`  [${label}] ${entry.stem}: mismatch rate vs FP32 reference = ${(mismatchRate * 100).toFixed(3)}%`);
      expect(mismatchRate).toBeLessThan(maxMismatchRate);
    });
  }
});
