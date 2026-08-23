import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ONNX_MODEL_PATH_FP16, ONNX_MODEL_PATH_INT8 } from "../test/fixtures.js";

/**
 * Real-browser batch-size-vs-throughput measurement (Issue #24),
 * WebGPU-side counterpart to test/batch-latency-benchmark.test.ts (Node,
 * WASM-only) -- via bench/batchBench.ts. Scoped to INT8 and FP16 (the two
 * variants this project's hardware-based model selection, Issue #35,
 * actually picks in production) rather than also including FP32, to keep
 * this focused and avoid FP32's 116MB external-data complexity for a
 * throughput-only measurement.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const FIXTURES_DIR = `${REPO_ROOT}ai-pipeline/quantization/calibration_data/inference_fixtures/`;

const SLICE_STEM = "LIDC-IDRI-0001_inst0034";
const SLICE_WIDTH = 512;
const SLICE_HEIGHT = 512;
// Matches test/batch-latency-benchmark.test.ts's own trimmed scope --
// batch=16/32 pushed WASM's compute-bound (not overhead-bound) scaling
// past Playwright's default per-test timeout under this project's
// observed system load, without changing the conclusion (gains already
// plateau by batch=8, see docs/verification/inference-worker.md §10).
const BATCH_SIZES = [1, 2, 4, 8];

interface BatchBenchResult {
  batchSize: number;
  msPerSlice: number;
}

const MODELS = [
  { label: "INT8", modelFile: "lungmask_r231_int8.onnx", modelPath: ONNX_MODEL_PATH_INT8 },
  { label: "FP16", modelFile: "lungmask_r231_fp16.onnx", modelPath: ONNX_MODEL_PATH_FP16 },
];

const EPS = ["wasm", "webgpu"] as const;

const allResults: { label: string; ep: string; results: BatchBenchResult[] }[] = [];

for (const { label, modelFile, modelPath } of MODELS) {
  for (const ep of EPS) {
    test(`${label} batch-size throughput, ${ep} EP (real browser)`, async ({ page }) => {
      test.setTimeout(120_000); // WASM batch runs are compute-bound, not overhead-bound -- see BATCH_SIZES comment
      await page.route(`**/${modelFile}`, (route) => route.fulfill({ path: modelPath }));
      await page.route("**/slice.bin", (route) => route.fulfill({ path: `${FIXTURES_DIR}${SLICE_STEM}_hu.bin` }));

      await page.goto(
        `/batch-bench.html?model=/${modelFile}&slice=/slice.bin&width=${SLICE_WIDTH}&height=${SLICE_HEIGHT}&ep=${ep}&batchSizes=${BATCH_SIZES.join(",")}`,
      );
      await page.waitForFunction(() => window.__batchBenchReady === true, undefined, { timeout: 60_000 });
      const result = (await page.evaluate(() => window.__batchBenchResult)) as
        | BatchBenchResult[]
        | { error: string };

      if (!Array.isArray(result)) {
        throw new Error(`${label}/${ep} batch bench failed in-browser: ${result?.error ?? "no result"}`);
      }

      allResults.push({ label, ep, results: result });
      expect(result).toHaveLength(BATCH_SIZES.length);
      for (const r of result) {
        expect(r.msPerSlice).toBeGreaterThan(0);
      }
    });
  }
}

test("reports the batch-size-vs-throughput summary table", () => {
  if (allResults.length === 0) return;
  for (const { label, ep, results } of allResults) {
    const baseline = results[0]!.msPerSlice; // batch size 1
    console.log(`\n${label} / ${ep}:`);
    console.table(
      results.map((r) => ({
        "batch size": r.batchSize,
        "ms/slice": r.msPerSlice.toFixed(1),
        "vs. batch=1": `${(baseline / r.msPerSlice).toFixed(2)}x`,
      })),
    );
  }
});
