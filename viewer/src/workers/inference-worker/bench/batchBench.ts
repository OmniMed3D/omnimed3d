// See worker.ts's own import comment -- the webgpu backend is a separate
// subpath, not enabled by the default "onnxruntime-web" import.
import * as ort from "onnxruntime-web/webgpu";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import { runBatch } from "../src/pipeline.js";

/**
 * Real-browser batch-size-vs-throughput benchmark (Issue #24), the
 * WebGPU-side counterpart to test/batch-latency-benchmark.test.ts (Node,
 * WASM-only). WebGPU is where per-call overhead is most likely to matter
 * (command submission, JS<->GPU marshalling) and where INT8's per-node
 * CPU-fallback cost (§8.3) is itself a repeated per-call cost batching
 * could help amortize -- reason enough to measure this on WebGPU
 * specifically, not just infer it from the WASM numbers.
 *
 * Same slice repeated to fill each batch (measures fixed per-call
 * overhead reduction, not per-content compute -- correctness is already
 * covered separately by test/batch-pipeline.test.ts).
 *
 * Query params: ?model=&slice=&width=&height=&ep=wasm|webgpu&batchSizes=
 * (comma-separated, e.g. "1,2,4,8,16,32").
 */

const REPEATS = 3;

interface BatchBenchResult {
  batchSize: number;
  msPerSlice: number;
}

declare global {
  interface Window {
    __batchBenchResult?: BatchBenchResult[] | { error: string };
    __batchBenchReady?: boolean;
  }
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const modelUrl = params.get("model");
  const sliceUrl = params.get("slice");
  const width = Number(params.get("width"));
  const height = Number(params.get("height"));
  const ep = params.get("ep") === "webgpu" ? (["webgpu", "wasm"] as const) : (["wasm"] as const);
  const batchSizes = (params.get("batchSizes") ?? "1,2,4,8,16,32").split(",").map(Number);
  if (!modelUrl || !sliceUrl || !width || !height) {
    throw new Error("batchBench.ts requires ?model=&slice=&width=&height= query params");
  }

  const sliceBuffer = await (await fetch(sliceUrl)).arrayBuffer();
  const slice = { data: new Float32Array(sliceBuffer), width, height };

  const adapter = new LungmaskAdapter(modelUrl);
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: [...ep] });

  const results: BatchBenchResult[] = [];
  for (const batchSize of batchSizes) {
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
    results.push({ batchSize, msPerSlice: mean(perRunMs) / batchSize });
  }

  window.__batchBenchResult = results;
}

run()
  .catch((err: unknown) => {
    window.__batchBenchResult = { error: err instanceof Error ? err.message : String(err) };
  })
  .finally(() => {
    window.__batchBenchReady = true;
  });
