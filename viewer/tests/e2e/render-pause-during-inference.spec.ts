import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Mobile OOM mitigation (refined C-2): the Inference Worker's
 * "inference-started"/"inference-ended" messages (worker.ts's
 * scheduleBatchFlush()) should pause/resume the Engine's rendering via
 * `_engine_set_render_paused`, so rendering and AI inference don't
 * compete for the same GPU.
 *
 * Drives the REAL message protocol end-to-end (real Parse Worker, real
 * Inference Worker, the dummy plumbing-only ONNX model
 * `shell-mask-integration.spec.ts` already uses) rather than injecting
 * a fake "inference-started" message directly -- this is what actually
 * proves worker.ts's real batch-flush code posts the message, not just
 * that main.ts reacts to it correctly if it arrived.
 *
 * Wraps the real `_engine_set_render_paused` WASM export (the
 * `mobile-render-perf.spec.ts` technique) to record the actual call
 * sequence rather than inferring it indirectly.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));
const dummyOnnxPath = fileURLToPath(new URL("../fixtures/dummy-lungmask.onnx", import.meta.url));

test("a real hu-slice inference pauses rendering, then resumes once the mask arrives", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 20000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.route("**/dummy-lungmask.onnx", (route) => route.fulfill({ path: dummyOnnxPath }));

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.evaluate(() => {
    (window as unknown as { __pauseCalls: number[] }).__pauseCalls = [];
    const real = window.Module._engine_set_render_paused.bind(window.Module);
    window.Module._engine_set_render_paused = (paused: number) => {
      (window as unknown as { __pauseCalls: number[] }).__pauseCalls.push(paused);
      return real(paused);
    };
  });

  await expect(page.locator("#render-pause-banner")).toBeHidden();

  const volumeId = await page.evaluate(() => {
    return new Promise<string>((resolve) => {
      window.omnimed3dTestHooks.inferenceWorker.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          window.omnimed3dTestHooks.inferenceWorker.removeEventListener("message", ack);
          resolve(window.omnimed3dTestHooks.startNewVolume());
        }
      });
      window.omnimed3dTestHooks.inferenceWorker.postMessage({ type: "init", modelPath: "/dummy-lungmask.onnx" });
    });
  });

  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");
  await page.evaluate(
    ({ base64, id }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId: id, files }, files);
    },
    { base64: ctSmallBase64, id: volumeId },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);
  await waitForLine(/WebGPUDevice::applyMaskSlice: volumeId=\d+ slice=0 applied/);

  const pauseCalls = await page.evaluate(() => (window as unknown as { __pauseCalls: number[] }).__pauseCalls);
  expect(pauseCalls).toEqual([1, 0]);
  await expect(page.locator("#render-pause-banner")).toBeHidden();
});
