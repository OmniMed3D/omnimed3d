import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Verifies whether `validateSession()` (added for the WebGPU
 * session/inference-failure fallback, PR #68) already solves the
 * separately-proposed "hide WebGPU's first-inference shader-compile cost
 * inside model loading" warmup issue as a side effect -- it runs a
 * throwaway inference through the real session before `init-complete`
 * fires, which is exactly what that issue asked for, just built for a
 * different reason (failure detection, not perceived latency).
 *
 * `e2e/latency-browser.spec.ts` (docs/verification/inference-worker.md
 * §8.4, where the ~2000ms first-iteration warmup cost was originally
 * measured) calls the adapter/session directly on the page's main thread
 * -- it never goes through worker.ts's own `self.onmessage` protocol, so
 * it can't see whether `validateSession()`'s warmup actually reaches the
 * first *real* hu-slice a caller sends after `init-complete`. This test
 * drives the real protocol via bench/workerHarness.ts (the harness built
 * for the fallback PR) to check exactly that.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const FIXTURES_DIR = `${REPO_ROOT}ai-pipeline/quantization/calibration_data/inference_fixtures/`;
const QUANT_DIR = `${REPO_ROOT}ai-pipeline/quantization/`;

const SLICE_STEM = "LIDC-IDRI-0001_inst0034";
const SLICE_WIDTH = 512;
const SLICE_HEIGHT = 512;
const ITERATIONS = 5;

interface InitCompleteResult {
  type: "init-complete";
  modelPath: string;
  gpuDetected: boolean;
  usedFallback: boolean;
}

test("first real hu-slice after init is not inflated by WebGPU shader-compile warmup", async ({ page }) => {
  await page.route("**/warmup-check_fp16.onnx", (route) =>
    route.fulfill({ path: `${QUANT_DIR}lungmask_r231_fp16.onnx` }),
  );
  await page.route("**/warmup-check_int8.onnx", (route) =>
    route.fulfill({ path: `${QUANT_DIR}lungmask_r231_int8.onnx` }),
  );
  await page.route("**/slice.bin", (route) =>
    route.fulfill({ path: `${FIXTURES_DIR}${SLICE_STEM}_hu.bin` }),
  );

  await page.goto("/worker-harness.html");

  const sliceBuffer = readFileSync(`${FIXTURES_DIR}${SLICE_STEM}_hu.bin`);
  // Passed through page.evaluate as a plain array -- the buffer is small
  // (512*512 float32 ≈ 1MB) and this is a one-off measurement test, not a
  // hot path, so the serialization cost here doesn't matter.
  const sliceFloats = Array.from(new Float32Array(sliceBuffer.buffer, sliceBuffer.byteOffset, sliceBuffer.length / 4));

  const initResult = await page.evaluate(() => {
    return new Promise<InitCompleteResult>((resolve) => {
      const w = window.__workerHarness!.worker;
      w.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          w.removeEventListener("message", ack);
          resolve(e.data);
        }
      });
      w.postMessage({ type: "init", modelBasePath: "/warmup-check" });
    });
  });
  console.log("init result:", JSON.stringify(initResult));
  expect(initResult.gpuDetected).toBe(true); // confirms this ran on WebGPU, where the warmup cost was measured

  const perSliceMs = await page.evaluate(
    ({ floats, width, height, iterations }) => {
      return new Promise<number[]>((resolve) => {
        const w = window.__workerHarness!.worker;
        const data = Float32Array.from(floats);
        const timings: number[] = [];
        let i = 0;
        let t0 = 0;

        function sendNext() {
          t0 = performance.now();
          const buf = data.slice().buffer; // fresh buffer each send -- postMessage transfers and detaches it
          w.postMessage(
            { type: "hu-slice", volumeId: "warmup-test", sliceIndex: i, width, height, data: buf },
            [buf],
          );
        }

        w.addEventListener("message", function onMsg(e: MessageEvent) {
          if (e.data.type === "mask-slice") {
            timings.push(performance.now() - t0);
            i++;
            if (i >= iterations) {
              w.removeEventListener("message", onMsg);
              resolve(timings);
            } else {
              sendNext();
            }
          }
        });
        sendNext();
      });
    },
    { floats: sliceFloats, width: SLICE_WIDTH, height: SLICE_HEIGHT, iterations: ITERATIONS },
  );

  console.table(perSliceMs.map((ms, idx) => ({ iteration: idx + 1, "round-trip (ms)": ms.toFixed(1) })));

  const first = perSliceMs[0]!;
  const restMean = perSliceMs.slice(1).reduce((a, b) => a + b, 0) / (perSliceMs.length - 1);
  console.log(`first: ${first.toFixed(1)}ms, mean of iterations 2-${ITERATIONS}: ${restMean.toFixed(1)}ms`);

  // Section 8.4 measured the *unwarmed* first-iteration gap at roughly
  // 4-13x the steady-state mean (e.g. INT8: ~2036ms vs ~506ms). This
  // asserts the gap collapsed to something in the same ballpark as normal
  // run-to-run noise, not that it's perfectly flat (real browser timing
  // always has some variance -- see this project's own repeated notes on
  // isolated-vs-concurrent measurement noise).
  expect(first).toBeLessThan(restMean * 2);
});
