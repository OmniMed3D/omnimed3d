import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ONNX_MODEL_PATH_FP16, ONNX_MODEL_PATH_INT8 } from "../test/fixtures.js";

/**
 * Confirms the actual accumulate-and-flush wiring in worker.ts (not just
 * the isolated runBatch() function, which test/batch-pipeline.test.ts and
 * the batch-latency-benchmark suites already cover) delivers a real
 * throughput benefit through the real message protocol: a burst of
 * hu-slice messages sent without waiting for each response should take
 * meaningfully less total time than sending the same number sequentially
 * (waiting for each mask-slice before sending the next) -- confirming
 * worker.ts's BATCH_WINDOW_MS/MAX_BATCH_SIZE wiring actually groups
 * concurrent arrivals into fewer session.run() calls, not just that the
 * underlying batching logic is capable of it in isolation.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const FIXTURES_DIR = `${REPO_ROOT}ai-pipeline/quantization/calibration_data/inference_fixtures/`;
const SLICE_STEM = "LIDC-IDRI-0001_inst0034";
const SLICE_WIDTH = 512;
const SLICE_HEIGHT = 512;
const SLICE_COUNT = 8;

test("a burst of hu-slice messages is meaningfully faster per-slice than sending them sequentially", async ({
  page,
}) => {
  // 3 trials, compared by sum rather than a single sequential/burst pair --
  // a shared CI runner's per-call scheduling noise (GC pause, thermal
  // throttle, noisy-neighbor VM contention) can occasionally be large
  // enough to flip a single-sample comparison even when the underlying
  // BATCH_WINDOW_MS/MAX_BATCH_SIZE speedup is real and working. Summing
  // across trials keeps the same "must be faster, not merely equal"
  // assertion while diluting one noisy trial's influence on the outcome.
  const TRIALS = 3;
  test.setTimeout(60_000);

  await page.route("**/throughput-check_fp16.onnx", (route) => route.fulfill({ path: ONNX_MODEL_PATH_FP16 }));
  await page.route("**/throughput-check_int8.onnx", (route) => route.fulfill({ path: ONNX_MODEL_PATH_INT8 }));

  await page.goto("/worker-harness.html");

  const sliceBuffer = readFileSync(`${FIXTURES_DIR}${SLICE_STEM}_hu.bin`);
  const sliceFloats = Array.from(new Float32Array(sliceBuffer.buffer, sliceBuffer.byteOffset, sliceBuffer.length / 4));

  await page.evaluate((basePath) => {
    return new Promise<void>((resolve) => {
      const w = window.__workerHarness!.worker;
      w.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          w.removeEventListener("message", ack);
          resolve();
        }
      });
      w.postMessage({ type: "init", modelBasePath: basePath });
    });
  }, "/throughput-check");

  const { sequentialTrialsMs, burstTrialsMs } = await page.evaluate(
    async ({ floats, width, height, sliceCount, trials }) => {
      const w = window.__workerHarness!.worker;
      const data = Float32Array.from(floats);

      function runSequential(volumeId: string): Promise<number> {
        return new Promise((resolve) => {
          const t0 = performance.now();
          let received = 0;
          function sendNext() {
            const buf = data.slice().buffer;
            w.postMessage({ type: "hu-slice", volumeId, sliceIndex: received, width, height, data: buf }, [buf]);
          }
          w.addEventListener("message", function onMsg(e: MessageEvent) {
            if (e.data.type === "mask-slice" && e.data.volumeId === volumeId) {
              received++;
              if (received >= sliceCount) {
                w.removeEventListener("message", onMsg);
                resolve(performance.now() - t0);
              } else {
                sendNext();
              }
            }
          });
          sendNext();
        });
      }

      function runBurst(volumeId: string): Promise<number> {
        return new Promise((resolve) => {
          const t0 = performance.now();
          let received = 0;
          w.addEventListener("message", function onMsg(e: MessageEvent) {
            if (e.data.type === "mask-slice" && e.data.volumeId === volumeId) {
              received++;
              if (received >= sliceCount) {
                w.removeEventListener("message", onMsg);
                resolve(performance.now() - t0);
              }
            }
          });
          for (let i = 0; i < sliceCount; i++) {
            const buf = data.slice().buffer;
            w.postMessage({ type: "hu-slice", volumeId, sliceIndex: i, width, height, data: buf }, [buf]);
          }
        });
      }

      // volumeId includes the trial index -- each trial's listeners must
      // only ever see that trial's own mask-slice responses, not a
      // previous trial's stragglers racing in late.
      const sequentialTrialsMs: number[] = [];
      const burstTrialsMs: number[] = [];
      for (let trial = 0; trial < trials; trial++) {
        sequentialTrialsMs.push(await runSequential(`seq-${trial}`));
        burstTrialsMs.push(await runBurst(`burst-${trial}`));
      }
      return { sequentialTrialsMs, burstTrialsMs };
    },
    { floats: sliceFloats, width: SLICE_WIDTH, height: SLICE_HEIGHT, sliceCount: SLICE_COUNT, trials: TRIALS },
  );

  const sequentialTotalMs = sequentialTrialsMs.reduce((a: number, b: number) => a + b, 0);
  const burstTotalMs = burstTrialsMs.reduce((a: number, b: number) => a + b, 0);

  console.log(
    `sequential per trial (ms): ${sequentialTrialsMs.map((ms: number) => ms.toFixed(1)).join(", ")} ` +
      `(total ${sequentialTotalMs.toFixed(1)}ms)`,
  );
  console.log(
    `burst per trial (ms): ${burstTrialsMs.map((ms: number) => ms.toFixed(1)).join(", ")} ` +
      `(total ${burstTotalMs.toFixed(1)}ms)`,
  );

  // Not a tight bound -- real-browser timing has run-to-run noise (this
  // project's own repeated finding) -- just confirms the burst path is
  // genuinely faster overall, not merely equal or worse. Compared as a
  // sum across TRIALS runs rather than a single pair, see the comment
  // above TRIALS for why.
  expect(burstTotalMs).toBeLessThan(sequentialTotalMs);
});
