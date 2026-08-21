import * as ort from "onnxruntime-web";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";

/**
 * Real-browser counterpart to test/latency-benchmark.test.ts (which runs
 * under Node/vitest). Deliberately calls the adapter/session directly on
 * the page's main thread -- same as the Node benchmark does -- rather than
 * going through the Inference Worker's postMessage protocol, so this
 * measures the same thing (preprocess/infer/postprocess wall-clock time)
 * without also mixing in worker message-passing overhead.
 *
 * Driven by e2e/latency-browser.spec.ts via page.route (model + slice
 * fixture) and query params (?model=...&slice=...&width=...&height=...&
 * externalData=... for the FP32 model's external-data companion file).
 * Results are exposed on `window.__benchResult` for the spec to read via
 * page.evaluate -- not printed, since this page has no visible UI.
 *
 * Mirrors worker.ts's own external-data handling (see its InitMessage doc
 * comment) -- fetching bytes ourselves and passing them via `externalData`
 * rather than relying on ort.InferenceSession.create() to resolve a
 * same-directory URL on its own, which it doesn't in a real browser.
 */

const ITERATIONS = 5;

interface BenchResult {
  preprocessMs: number[];
  inferMs: number[];
  postprocessMs: number[];
}

declare global {
  interface Window {
    __benchResult?: BenchResult | { error: string };
    __benchReady?: boolean;
  }
}

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const modelUrl = params.get("model");
  const sliceUrl = params.get("slice");
  const externalDataUrl = params.get("externalData");
  const width = Number(params.get("width"));
  const height = Number(params.get("height"));
  if (!modelUrl || !sliceUrl || !width || !height) {
    throw new Error("bench.ts requires ?model=&slice=&width=&height= query params");
  }

  const sliceBuffer = await (await fetch(sliceUrl)).arrayBuffer();
  const slice = { data: new Float32Array(sliceBuffer), width, height };

  const adapter = new LungmaskAdapter(modelUrl);
  const options: ort.InferenceSession.SessionOptions = {};
  if (externalDataUrl) {
    const bytes = new Uint8Array(await (await fetch(externalDataUrl)).arrayBuffer());
    const externalDataName = externalDataUrl.split("/").pop()!;
    options.externalData = [{ path: externalDataName, data: bytes }];
  }
  const session = await ort.InferenceSession.create(modelUrl, options);

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

  window.__benchResult = { preprocessMs, inferMs, postprocessMs };
}

run()
  .catch((err: unknown) => {
    window.__benchResult = { error: err instanceof Error ? err.message : String(err) };
  })
  .finally(() => {
    window.__benchReady = true;
  });
