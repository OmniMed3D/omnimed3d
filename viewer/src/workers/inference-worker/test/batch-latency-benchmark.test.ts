import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import { runBatch } from "../src/pipeline.js";
import {
  loadFloat32Bin,
  loadManifest,
  ONNX_MODEL_PATH_FP16,
  ONNX_MODEL_PATH_INT8,
} from "./fixtures.js";

/**
 * Picks a batch size for Issue #24 from measurement, not a guess (its own
 * DoD requirement). Same slice repeated to fill each batch -- this
 * measures fixed per-call overhead reduction, not per-content compute
 * (batch-pipeline.test.ts already confirmed correctness/content-identity
 * separately), matching Section 3's own precedent of reusing one slice
 * across repeated timing runs.
 *
 * WASM-only (Node has no WebGPU) -- this project's own Section 3/6/8
 * pattern of a Node-side benchmark plus a real-browser one for WebGPU
 * applies here too; see e2e/batch-latency-browser.spec.ts for the WebGPU
 * side, which is where batching matters most (INT8's per-node
 * CPU-fallback overhead, §8.3, is a per-call cost batching could also
 * help amortize).
 */
const BATCH_SIZES = [1, 2, 4, 8];
const REPEATS = 2;

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe("batch size vs. per-slice throughput (WASM)", () => {
  const entry = loadManifest()[0]!;
  const slice = {
    data: loadFloat32Bin(entry.stem, "hu"),
    width: entry.originalWidth,
    height: entry.originalHeight,
  };

  for (const modelLabel of ["INT8", "FP16"] as const) {
    describe(modelLabel, () => {
      let session: ort.InferenceSession;
      const adapter = new LungmaskAdapter(modelLabel === "INT8" ? ONNX_MODEL_PATH_INT8 : ONNX_MODEL_PATH_FP16);

      beforeAll(async () => {
        const path = modelLabel === "INT8" ? ONNX_MODEL_PATH_INT8 : ONNX_MODEL_PATH_FP16;
        session = await ort.InferenceSession.create(readFileSync(path));
      });

      const results: { batchSize: number; msPerSlice: number }[] = [];

      it.each(BATCH_SIZES)("batch size %i", async (batchSize) => {
        const requests = Array.from({ length: batchSize }, (_, i) => ({
          volumeId: "batch-bench",
          sliceIndex: i,
          slice,
        }));

        const perRunMs: number[] = [];
        for (let r = 0; r < REPEATS; r++) {
          const t0 = performance.now();
          await runBatch(adapter, session, requests);
          perRunMs.push(performance.now() - t0);
        }

        const msPerSlice = mean(perRunMs) / batchSize;
        results.push({ batchSize, msPerSlice });
        expect(msPerSlice).toBeGreaterThan(0);
      });

      it("reports batch-size-vs-throughput table", () => {
        if (results.length === 0) return;
        console.table(
          results.map((r) => ({
            model: modelLabel,
            "batch size": r.batchSize,
            "ms/slice": r.msPerSlice.toFixed(1),
            "vs. batch=1": `${(results[0]!.msPerSlice / r.msPerSlice).toFixed(2)}x`,
          })),
        );
      });
    });
  }
});
