import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Mobile OOM mitigation, Option D: during an AI inference run, the Shell
 * should release the Engine's GPU-resident volume/gradient/mask textures
 * (_engine_unload_volume) rather than just pausing rendering (refined
 * C-2, already covered by render-pause-during-inference.spec.ts) --
 * real-device testing found the two together still weren't enough to
 * avoid an iOS WebKit OOM crash, since C-2 never freed the ~100MB of
 * GPU-resident textures themselves. Any mask-slice result arriving while
 * unloaded must be buffered instead of applied (applyMaskSlice() silently
 * no-ops with no volume loaded -- WebGPUDevice.cpp's !hasVolume_ guard),
 * then replayed once the volume reloads.
 *
 * The initial volume load goes through the REAL Parse Worker (CT_small.dcm,
 * same fixture render-pause-during-inference.spec.ts uses) so
 * engineLoadVolume()'s real retention wiring (currentVolumeForGpuReload)
 * is genuinely exercised, not faked. The inference-started/mask-slice/
 * inference-ended sequence that follows is injected directly on
 * inferenceWorker.onmessage instead of driven by a real ONNX session --
 * real inference timing against a tiny dummy model races unpredictably
 * against DICOM parsing for a fixture this small, and this test needs
 * deterministic control over exactly when each message arrives to assert
 * the buffering/debounce/replay behavior precisely.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));

interface TestWindow {
  __unloadCalls: number;
  __loadCalls: number[];
}

test("Engine volume textures unload for an inference run and reload once it settles, replaying buffered mask-slices", async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 20000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__unloadCalls = 0;
    w.__loadCalls = [];
    const realUnload = window.Module._engine_unload_volume.bind(window.Module);
    window.Module._engine_unload_volume = () => {
      w.__unloadCalls++;
      return realUnload();
    };
    const realLoad = window.Module._engine_load_volume.bind(window.Module);
    window.Module._engine_load_volume = (...args: Parameters<typeof window.Module._engine_load_volume>) => {
      w.__loadCalls.push(args[0]);
      return realLoad(...args);
    };
  });

  const volumeId = await page.evaluate(() => window.omnimed3dTestHooks.startNewVolume());

  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");
  await page.evaluate(
    ({ base64, id }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId: id, files }, files);
    },
    { base64: ctSmallBase64, id: volumeId },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ \d+x\d+x\d+ loaded/);

  const loadLine = consoleLines.find((line) => /WebGPUDevice::loadVolume: volumeId=\d+ \d+x\d+x\d+ loaded/.test(line))!;
  const [, width, height] = /volumeId=\d+ (\d+)x(\d+)x\d+ loaded/.exec(loadLine)!;

  const loadCallsAfterInitialLoad = await page.evaluate(() => (window as unknown as TestWindow).__loadCalls.length);
  expect(loadCallsAfterInitialLoad).toBe(1);

  // Simulate the Inference Worker starting a batch flush -- should release
  // the Engine's GPU textures.
  await page.evaluate(() => {
    window.omnimed3dTestHooks.inferenceWorker.onmessage!({ data: { type: "inference-started" } } as MessageEvent);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__unloadCalls))
    .toBe(1);
  await expect(page.locator("#render-pause-banner")).toBeVisible();

  // A mask-slice arriving while unloaded must be buffered, not applied --
  // no "applyMaskSlice ... applied" console line yet.
  await page.evaluate(
    ({ id, w, h }) => {
      const mask = new Uint8Array(w * h);
      window.omnimed3dTestHooks.inferenceWorker.onmessage!({
        data: { type: "mask-slice", volumeId: id, sliceIndex: 0, width: w, height: h, data: mask.buffer },
      } as MessageEvent);
    },
    { id: volumeId, w: Number(width), h: Number(height) },
  );
  await page.waitForTimeout(200);
  expect(consoleLines.some((line) => /WebGPUDevice::applyMaskSlice: volumeId=\d+ slice=0 applied/.test(line))).toBe(
    false,
  );

  // A second "inference-started" mid-run (another flush cycle) must not
  // trigger a second unload -- already unloaded, idempotent no-op.
  await page.evaluate(() => {
    window.omnimed3dTestHooks.inferenceWorker.onmessage!({ data: { type: "inference-started" } } as MessageEvent);
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__unloadCalls)).toBe(1);

  // Ends the run -- starts the reload-debounce window. A flush cycle ending
  // mid-run (more slices still coming) should NOT reload -- simulate one
  // more "inference-started" arriving inside the debounce window, which
  // must cancel the pending reload.
  await page.evaluate(() => {
    window.omnimed3dTestHooks.inferenceWorker.onmessage!({ data: { type: "inference-ended" } } as MessageEvent);
  });
  await page.waitForTimeout(200); // well inside the 750ms debounce window
  await page.evaluate(() => {
    window.omnimed3dTestHooks.inferenceWorker.onmessage!({ data: { type: "inference-started" } } as MessageEvent);
  });
  await page.waitForTimeout(900); // past 750ms from the cancelled inference-ended, had it not been cancelled
  expect(await page.evaluate(() => (window as unknown as TestWindow).__loadCalls.length)).toBe(1); // still just the initial load -- no premature reload

  // Now actually end the run and let the debounce fire for real.
  await page.evaluate(() => {
    window.omnimed3dTestHooks.inferenceWorker.onmessage!({ data: { type: "inference-ended" } } as MessageEvent);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__loadCalls.length), { timeout: 5000 })
    .toBe(2); // the reload
  await waitForLine(/WebGPUDevice::applyMaskSlice: volumeId=\d+ slice=0 applied/); // buffered mask-slice replayed
  expect(await page.evaluate(() => (window as unknown as TestWindow).__unloadCalls)).toBe(1); // still just the one unload for the whole run
  await expect(page.locator("#render-pause-banner")).toBeHidden();
});
