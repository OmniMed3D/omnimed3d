import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Real-browser counterpart to test/latency-benchmark.test.ts (Section 3 of
 * docs/verification/inference-worker.md), which only ever ran under Node.
 * Reproduces the exact same methodology -- same single slice
 * (LIDC-IDRI-0001_inst0034, entry 0 of the ground-truth manifest), same
 * iteration count (5), same "mean of wall-clock ms, no separate warmup
 * excluded from the mean" -- via bench/bench.ts, so the two sets of
 * numbers are directly comparable rather than just similar in spirit.
 *
 * Models are served via page.route() at their real filenames (not
 * renamed) so worker.ts's external-data handling (see its InitMessage doc
 * comment) can pass that same filename through to onnxruntime-web.
 *
 * The FP32 model's 116MB external-data companion (`lungmask_r231.onnx.data`)
 * is the one exception -- NOT routed via page.route(), served instead
 * through Vite's own /@fs/ static-file path (see vite.config.ts's
 * `server.fs.allow` comment for why: page.route().fulfill() proxies the
 * response body through Chromium's CDP pipe, which has a hard 100MB
 * capacity and crashes the browser outright on a file this size --
 * confirmed by a real crash the first time this test tried it, not a
 * theoretical concern).
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const FIXTURES_DIR = `${REPO_ROOT}ai-pipeline/quantization/calibration_data/inference_fixtures/`;
const FP32_DIR = `${REPO_ROOT}ai-pipeline/conversion/adapters/lungmask/`;
const QUANT_DIR = `${REPO_ROOT}ai-pipeline/quantization/`;

const SLICE_STEM = "LIDC-IDRI-0001_inst0034";
const SLICE_WIDTH = 512;
const SLICE_HEIGHT = 512;

interface BenchResult {
  preprocessMs: number[];
  inferMs: number[];
  postprocessMs: number[];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const MODELS = [
  { label: "FP32", modelFile: "lungmask_r231.onnx", dir: FP32_DIR, hasExternalData: true },
  { label: "INT8", modelFile: "lungmask_r231_int8.onnx", dir: QUANT_DIR, hasExternalData: false },
  { label: "FP16", modelFile: "lungmask_r231_fp16.onnx", dir: QUANT_DIR, hasExternalData: false },
];

const results: { label: string; meanPreprocessMs: number; meanInferMs: number; meanPostprocessMs: number }[] = [];

for (const { label, modelFile, dir, hasExternalData } of MODELS) {
  test(`${label} per-slice latency (real browser)`, async ({ page }) => {
    await page.route(`**/${modelFile}`, (route) => route.fulfill({ path: `${dir}${modelFile}` }));
    await page.route("**/slice.bin", (route) => route.fulfill({ path: `${FIXTURES_DIR}${SLICE_STEM}_hu.bin` }));

    // See the module doc comment -- deliberately not page.route(), that's
    // what crashed the browser on this specific (116MB) file.
    const externalDataParam = hasExternalData ? `&externalData=/@fs${dir}${modelFile}.data` : "";
    await page.goto(
      `/?model=/${modelFile}&slice=/slice.bin&width=${SLICE_WIDTH}&height=${SLICE_HEIGHT}${externalDataParam}`,
    );
    await page.waitForFunction(() => window.__benchReady === true, undefined, { timeout: 60_000 });
    const result = (await page.evaluate(() => window.__benchResult)) as BenchResult | { error: string };

    if (!result || "error" in result) {
      throw new Error(`${label} bench failed in-browser: ${result?.error ?? "no result"}`);
    }

    const meanInferMs = mean(result.inferMs);
    const meanPostprocessMs = mean(result.postprocessMs);
    results.push({
      label,
      meanPreprocessMs: mean(result.preprocessMs),
      meanInferMs,
      meanPostprocessMs,
    });

    expect(meanInferMs).toBeGreaterThan(0);
  });
}

test("reports the summary table", () => {
  // Depends on the loop above having run first -- Playwright runs tests
  // within one file in declaration order when workers=1/fullyParallel=false
  // (see playwright.config.ts), same assumption the Node benchmark makes.
  if (results.length === 0) return;
  console.table(
    results.map((r) => ({
      model: r.label,
      "preprocess (ms)": r.meanPreprocessMs.toFixed(1),
      "infer (ms)": r.meanInferMs.toFixed(1),
      "postprocess (ms)": r.meanPostprocessMs.toFixed(1),
      "PRD budget: infer+postprocess (ms)": (r.meanInferMs + r.meanPostprocessMs).toFixed(1),
      "under 500ms target?": r.meanInferMs + r.meanPostprocessMs < 500 ? "yes" : "NO",
    })),
  );
});
