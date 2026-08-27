import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ONNX_MODEL_PATH_FP16, ONNX_MODEL_PATH_INT8 } from "../test/fixtures.js";

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
 * capacity and crashes the browser outright on a file this size).
 *
 * Runs each model on both EPs (Issue #35): "wasm" reproduces this file's
 * long-standing baseline unchanged; "webgpu" adds bench.ts's `verbose=1`
 * flag and captures ORT's verbose console log to check per-node EP
 * placement -- an op WebGPU's JSEP backend can't run falls back to WASM
 * per-node (logged as "webgpu kernel not found in registries for Op type:
 * X"), which is exactly the silent-CPU-fallback risk the issue calls out
 * for INT8's QuantizeLinear/DequantizeLinear nodes. Reported per model
 * rather than asserted on, since some fallback (e.g. the graph's final
 * LogSoftmax on every model) is expected and harmless.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const FIXTURES_DIR = `${REPO_ROOT}ai-pipeline/quantization/calibration_data/inference_fixtures/`;
const FP32_DIR = `${REPO_ROOT}ai-pipeline/conversion/adapters/lungmask/`;

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

interface ModelEntry {
  label: string;
  modelFile: string;
  modelPath: string;
  hasExternalData: boolean;
  externalDataPath?: string;
}

const MODELS: ModelEntry[] = [
  {
    label: "FP32",
    modelFile: "lungmask_r231.onnx",
    modelPath: `${FP32_DIR}lungmask_r231.onnx`,
    externalDataPath: `/@fs${FP32_DIR}lungmask_r231.onnx.data`,
    hasExternalData: true,
  },
  { label: "INT8", modelFile: "lungmask_r231_int8.onnx", modelPath: ONNX_MODEL_PATH_INT8, hasExternalData: false },
  { label: "FP16", modelFile: "lungmask_r231_fp16.onnx", modelPath: ONNX_MODEL_PATH_FP16, hasExternalData: false },
];

const EPS = ["wasm", "webgpu"] as const;

const results: {
  label: string;
  ep: string;
  meanPreprocessMs: number;
  meanInferMs: number;
  meanPostprocessMs: number;
  meanInferMsWarm: number; // excludes iteration 1 -- see module doc comment on WebGPU's shader-compile warmup cost
  cpuFallbackOps: string; // e.g. "QuantizeLinear x117, LogSoftmax x2" -- always "" for ep=wasm
}[] = [];

for (const { label, modelFile, modelPath, hasExternalData, externalDataPath } of MODELS) {
  for (const ep of EPS) {
    test(`${label} per-slice latency, ${ep} EP (real browser)`, async ({ page }) => {
      const fallbackLogs: string[] = [];
      if (ep === "webgpu") {
        page.on("console", (msg) => {
          const text = msg.text();
          if (text.includes("kernel not found in registries")) fallbackLogs.push(text);
        });
      }

      await page.route(`**/${modelFile}`, (route) => route.fulfill({ path: modelPath }));
      await page.route("**/slice.bin", (route) => route.fulfill({ path: `${FIXTURES_DIR}${SLICE_STEM}_hu.bin` }));

      // See the module doc comment -- deliberately not page.route(), that's
      // what crashed the browser on this specific (116MB) file.
      const externalDataParam = hasExternalData ? `&externalData=${externalDataPath}` : "";
      const verboseParam = ep === "webgpu" ? "&verbose=1" : "";
      await page.goto(
        `/?model=/${modelFile}&slice=/slice.bin&width=${SLICE_WIDTH}&height=${SLICE_HEIGHT}&ep=${ep}${externalDataParam}${verboseParam}`,
      );
      await page.waitForFunction(() => window.__benchReady === true, undefined, { timeout: 60_000 });
      const result = (await page.evaluate(() => window.__benchResult)) as BenchResult | { error: string };

      if (!result || "error" in result) {
        throw new Error(`${label}/${ep} bench failed in-browser: ${result?.error ?? "no result"}`);
      }

      const meanInferMs = mean(result.inferMs);
      const meanPostprocessMs = mean(result.postprocessMs);

      const fallbackCounts = new Map<string, number>();
      for (const line of fallbackLogs) {
        const m = /Op type: (\S+)/.exec(line);
        if (m?.[1]) fallbackCounts.set(m[1], (fallbackCounts.get(m[1]) ?? 0) + 1);
      }

      results.push({
        label,
        ep,
        meanPreprocessMs: mean(result.preprocessMs),
        meanInferMs,
        meanPostprocessMs,
        meanInferMsWarm: mean(result.inferMs.slice(1)),
        cpuFallbackOps: [...fallbackCounts.entries()].map(([op, n]) => `${op} x${n}`).join(", "),
      });

      expect(meanInferMs).toBeGreaterThan(0);
    });
  }
}

test("reports the summary table", () => {
  // Depends on the loops above having run first -- Playwright runs tests
  // within one file in declaration order when workers=1/fullyParallel=false
  // (see playwright.config.ts), same assumption the Node benchmark makes.
  if (results.length === 0) return;
  console.table(
    results.map((r) => ({
      model: r.label,
      EP: r.ep,
      "preprocess (ms)": r.meanPreprocessMs.toFixed(1),
      "infer, all 5 iters (ms)": r.meanInferMs.toFixed(1),
      "infer, iters 2-5 only (ms)": r.meanInferMsWarm.toFixed(1),
      "postprocess (ms)": r.meanPostprocessMs.toFixed(1),
      "PRD budget: infer+postprocess (ms)": (r.meanInferMs + r.meanPostprocessMs).toFixed(1),
      "under 500ms target?": r.meanInferMs + r.meanPostprocessMs < 500 ? "yes" : "NO",
      "CPU-fallback ops (webgpu only)": r.cpuFallbackOps,
    })),
  );
});
