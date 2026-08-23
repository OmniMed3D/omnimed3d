import { expect, test } from "@playwright/test";
import { ONNX_MODEL_PATH_FP16, ONNX_MODEL_PATH_INT8 } from "../test/fixtures.js";

/**
 * Verifies the WebGPU-session-failure fallback (issue: "Recover from
 * WebGPU session/inference failure after hardware detection succeeds")
 * against a real, not mocked, failure: routes the FP16 model URL to
 * corrupted bytes so `ort.InferenceSession.create()` genuinely throws
 * (an invalid ONNX protobuf), rather than faking a WebGPU-specific
 * driver issue -- worker.ts's try/catch doesn't distinguish *why*
 * session creation failed, so this exercises the exact same recovery
 * code path a real Dawn/driver failure would, without needing to
 * reproduce WebGPU internals specifically.
 *
 * Drives the real message protocol via bench/workerHarness.ts (a real
 * `new Worker(worker.ts)`, not bench.ts's direct session calls), so this
 * is testing worker.ts's own `self.onmessage` handling end-to-end, the
 * same way the Shell's main.ts does.
 */

interface InitCompleteResult {
  type: "init-complete";
  modelPath: string;
  gpuDetected: boolean;
  usedFallback: boolean;
}

async function postInitAndWait(page: import("@playwright/test").Page, modelBasePath: string) {
  return page.evaluate((basePath) => {
    return new Promise((resolve) => {
      const w = window.__workerHarness!.worker;
      w.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          w.removeEventListener("message", ack);
          resolve(e.data);
        }
      });
      w.postMessage({ type: "init", modelBasePath: basePath });
    });
  }, modelBasePath) as Promise<InitCompleteResult>;
}

test("recovers to INT8/WASM when the WebGPU-selected FP16 session fails to create", async ({ page }) => {
  await page.route("**/probe-broken_fp16.onnx", (route) =>
    route.fulfill({ body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]) }),
  );
  await page.route("**/probe-broken_int8.onnx", (route) => route.fulfill({ path: ONNX_MODEL_PATH_INT8 }));

  await page.goto("/worker-harness.html");
  const result = await postInitAndWait(page, "/probe-broken");

  expect(result.usedFallback).toBe(true);
  expect(result.gpuDetected).toBe(false);
  expect(result.modelPath).toContain("int8");
});

test("does not fall back when the FP16/WebGPU session is healthy (regression guard)", async ({ page }) => {
  await page.route("**/probe-healthy_fp16.onnx", (route) => route.fulfill({ path: ONNX_MODEL_PATH_FP16 }));
  await page.route("**/probe-healthy_int8.onnx", (route) => route.fulfill({ path: ONNX_MODEL_PATH_INT8 }));

  await page.goto("/worker-harness.html");
  const result = await postInitAndWait(page, "/probe-healthy");

  expect(result.usedFallback).toBe(false);
  expect(result.gpuDetected).toBe(true);
  expect(result.modelPath).toContain("fp16");
});
