import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import {
  ONNX_MODEL_PATH,
  ONNX_MODEL_PATH_FP16,
  ONNX_MODEL_PATH_INT8,
  loadFloat32Bin,
  loadManifest,
} from "./fixtures.js";

/**
 * Per-slice latency (issue DoD item; PRD Section 4 target: <500ms/slice).
 * The PRD's budget is scoped to "forward pass -> upscale" (see CLAUDE.md's
 * "Success Metrics Owned" section) -- i.e. infer() + postprocess(), NOT
 * preprocess() -- so that's reported as its own column. preprocess() is
 * reported separately for visibility since it's still real wall-clock cost
 * following REQ-A04's ownership move, just not counted against this
 * specific budget.
 *
 * Not a pass/fail gate on the 500ms figure itself (the issue's DoD only
 * asks for this to be measured and reported, not met yet) -- only sanity
 * bounds are asserted, to catch a hang/regression rather than a slow but
 * working machine. This machine's absolute numbers are not a substitute
 * for measuring on representative target hardware.
 *
 * vitest's own `bench()` API (tried first) produced 0 samples for the
 * async onnxruntime-web calls here -- flagged "experimental" in its own
 * output -- so this uses plain timed loops instead, which don't have that
 * problem (verified directly against the same adapter/session calls).
 */
const ITERATIONS = 5;
const SANITY_CEILING_MS = 15_000; // generous -- only meant to catch a hang, not enforce the 500ms target

interface Timing {
  label: string;
  meanPreprocessMs: number;
  meanInferMs: number;
  meanPostprocessMs: number;
  meanBudgetMs: number; // infer + postprocess -- the PRD-defined <500ms figure
  meanTotalMs: number; // preprocess + infer + postprocess -- real wall-clock cost
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function measure(
  adapter: LungmaskAdapter,
  session: ort.InferenceSession,
  slice: { data: Float32Array; width: number; height: number },
) {
  const preprocessMs: number[] = [];
  const inferMs: number[] = [];
  const postprocessMs: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    let t0 = performance.now();
    const { tensor, meta } = adapter.preprocess(slice);
    preprocessMs.push(performance.now() - t0);

    t0 = performance.now();
    const logits = await adapter.infer(session, tensor);
    inferMs.push(performance.now() - t0);

    t0 = performance.now();
    adapter.postprocess(logits, meta, { width: slice.width, height: slice.height });
    postprocessMs.push(performance.now() - t0);
  }

  return { preprocessMs, inferMs, postprocessMs };
}

describe("per-slice latency (FP32/INT8/FP16)", () => {
  const entry = loadManifest()[0]!;
  const hu = loadFloat32Bin(entry.stem, "hu");
  const slice = { data: hu, width: entry.originalWidth, height: entry.originalHeight };

  const results: Timing[] = [];

  it.each([
    { label: "FP32", modelPath: ONNX_MODEL_PATH, hasExternalData: true },
    { label: "INT8", modelPath: ONNX_MODEL_PATH_INT8, hasExternalData: false },
    { label: "FP16", modelPath: ONNX_MODEL_PATH_FP16, hasExternalData: false },
  ])("$label", async ({ label, modelPath, hasExternalData }) => {
    const adapter = new LungmaskAdapter(modelPath);
    const modelBuffer = readFileSync(modelPath);
    const session = hasExternalData
      ? await ort.InferenceSession.create(modelBuffer, {
          externalData: [{ path: "lungmask_r231.onnx.data", data: readFileSync(`${modelPath}.data`) }],
        })
      : await ort.InferenceSession.create(modelBuffer);

    const { preprocessMs, inferMs, postprocessMs } = await measure(adapter, session, slice);
    const meanInfer = mean(inferMs);
    const meanPostprocess = mean(postprocessMs);
    const meanPreprocess = mean(preprocessMs);
    const meanBudget = meanInfer + meanPostprocess;

    results.push({
      label,
      meanPreprocessMs: meanPreprocess,
      meanInferMs: meanInfer,
      meanPostprocessMs: meanPostprocess,
      meanBudgetMs: meanBudget,
      meanTotalMs: meanPreprocess + meanBudget,
    });

    expect(meanBudget).toBeGreaterThan(0);
    expect(meanBudget).toBeLessThan(SANITY_CEILING_MS);
  });

  it("reports the summary table", () => {
    // Depends on it.each above having populated `results` -- vitest runs
    // it/it.each in file order within a describe block, so this is safe.
    if (results.length === 0) return;
    console.table(
      results.map((r) => ({
        model: r.label,
        "preprocess (ms)": r.meanPreprocessMs.toFixed(1),
        "infer (ms)": r.meanInferMs.toFixed(1),
        "postprocess (ms)": r.meanPostprocessMs.toFixed(1),
        "PRD budget: infer+postprocess (ms)": r.meanBudgetMs.toFixed(1),
        "under 500ms target?": r.meanBudgetMs < 500 ? "yes" : "NO",
        "total wall-clock (ms)": r.meanTotalMs.toFixed(1),
      })),
    );
  });
});
