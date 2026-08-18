import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Issue #20 DoD verification: real postMessage/Transferable through real
 * browser Workers, Shell -> Engine WASM compositor wiring, out-of-order
 * slice delivery, and stale-volumeId rejection (PRD §5.3.2).
 *
 * The first test's assertions are made against the Engine's own C++ stdout
 * log lines (WebGPUDevice.cpp's std::printf calls, forwarded to the
 * browser console via index.html's Module.print), not new engine-side
 * readback code -- these lines already existed to prove commit 05534b3's
 * synthetic smoke test worked; this test makes that claim reproducible.
 *
 * The second test (issue #29 DoD) is the first one in this repo that
 * asserts anything about what's actually on screen -- WebGPUDevice::
 * renderFrame() didn't sample the volume/mask textures at all until #29's
 * raymarch pass existed. No headless-Chrome screenshot tooling existed
 * anywhere in this repo before this (the one prior "verified with a
 * screenshot" note, referenced in an earlier version of this file, was a
 * manual, non-reproducible, one-off step -- confirmed via
 * docs/verification/shell-mask-integration.md, not assumed).
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));
const dummyOnnxPath = fileURLToPath(new URL("../fixtures/dummy-lungmask.onnx", import.meta.url));

test("real Worker postMessage/Transferable, Shell to Engine wiring, out-of-order delivery, stale-volumeId rejection", async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  function countLines(pattern: RegExp): number {
    return consoleLines.filter((line) => pattern.test(line)).length;
  }

  await page.route("**/dummy-lungmask.onnx", (route) => route.fulfill({ path: dummyOnnxPath }));

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");

  // Init the Inference Worker with the dummy model (plumbing only -- see
  // module doc comment) and wait for its own async session-load ack
  // before minting a volume / sending anything downstream of it --
  // sending hu-slice before this resolves races the load (found via real
  // browser e2e testing; see worker.ts's "init-complete" comment).
  const volumeIdA = await page.evaluate(() => {
    return new Promise<string>((resolve) => {
      window.omnimed3dTestHooks.inferenceWorker.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          window.omnimed3dTestHooks.inferenceWorker.removeEventListener("message", ack);
          resolve(window.omnimed3dTestHooks.startNewVolume());
        }
      });
      window.omnimed3dTestHooks.inferenceWorker.postMessage({
        type: "init",
        modelPath: "/dummy-lungmask.onnx",
      });
    });
  });
  expect(volumeIdA).toBeTruthy();

  // Real Parse Worker leg: parse-series with the same real DICOM file
  // "3 times" (a depth=3 volume out of one real slice -- explicitly
  // synthetic multi-slice construction, not a real series, per the
  // plan's fixture-availability note) via real postMessage/Transferable.
  // Produces one volume-ready (-> engine_load_volume) and 3 hu-slice
  // messages, auto-routed by main.ts to the Inference Worker.
  await page.evaluate(
    ({ base64, volumeId }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer.slice(0), bytes.buffer.slice(0), bytes.buffer.slice(0)];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId, files }, files);
    },
    { base64: ctSmallBase64, volumeId: volumeIdA },
  );

  // volume-ready's engine_load_volume call is synchronous C++ once it
  // arrives; wait for its real success log before anything mask-related.
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=1 .* loaded/);

  // The 3 hu-slice messages from parse-series each round-trip through the
  // (dummy-model) Inference Worker asynchronously; wait for all 3
  // resulting mask-slice deliveries to reach the real compositor.
  await expect
    .poll(() => countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/), { timeout: 20000 })
    .toBe(3);

  // Out-of-order delivery: 3 explicit parse-file calls with sliceIndex
  // 2, 0, 1 in that send order, same real DICOM bytes, same loaded
  // volume (depth=3, so all in range). Each flows through the real
  // Inference Worker independently.
  await page.evaluate(
    ({ base64, volumeId }) => {
      for (const sliceIndex of [2, 0, 1]) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        window.omnimed3dTestHooks.parseWorker.postMessage(
          { type: "parse-file", volumeId, sliceIndex, fileBytes: bytes.buffer },
          [bytes.buffer],
        );
      }
    },
    { base64: ctSmallBase64, volumeId: volumeIdA },
  );
  await expect
    .poll(() => countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/), { timeout: 20000 })
    .toBe(6);
  expect(countLines(/WebGPUDevice::applyMaskSlice:.*ignoring/)).toBe(0);

  // Stale-volumeId rejection (PRD §5.3.2): mint a second volume, load it
  // (making it "current"), then send a mask-producing hu-slice still
  // carrying the FIRST volumeId. The Shell's own guard (main.ts's
  // engineApplyMaskSlice) must discard it before it ever reaches WASM.
  const volumeIdB = await page.evaluate(() => window.omnimed3dTestHooks.startNewVolume());
  await page.evaluate(
    ({ base64, volumeId }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId, files }, files);
    },
    { base64: ctSmallBase64, volumeId: volumeIdB },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=2 .* loaded/);

  const staleAppliedCountBefore = countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/);
  await page.evaluate(
    ({ base64, volumeId }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      window.omnimed3dTestHooks.parseWorker.postMessage(
        { type: "parse-file", volumeId, sliceIndex: 0, fileBytes: bytes.buffer },
        [bytes.buffer],
      );
    },
    { base64: ctSmallBase64, volumeId: volumeIdA },
  );
  await waitForLine(/Shell: discarding mask-slice for stale volumeId=/);
  // The stale slice must never have reached the Engine at all.
  expect(countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/)).toBe(staleAppliedCountBefore);
});

test("raymarch pass actually draws real DICOM data, not just the flat clear color (issue #29)", async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const canvas = page.locator("#canvas");

  // Before any volume is loaded, renderFrame() only clears the canvas --
  // this screenshot is the flat background baseline the post-load one is
  // compared against below.
  const beforeLoad = await canvas.screenshot();

  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");
  const volumeId = await page.evaluate(() => window.omnimed3dTestHooks.startNewVolume());
  await page.evaluate(
    ({ base64, id }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId: id, files }, files);
    },
    { base64: ctSmallBase64, id: volumeId },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);

  // renderFrame() runs once per requestAnimationFrame tick -- give it a
  // few real frames to pick up the newly loaded volume/bind group before
  // capturing the "after" screenshot.
  await page.waitForTimeout(500);
  const afterLoad = await canvas.screenshot();

  // A real, not fabricated, visual check: byte-identical PNGs would mean
  // the raymarch pass drew literally nothing different from the
  // clear-only baseline. No pixel-decoding dependency needed -- any real
  // difference in rendered output changes the encoded PNG bytes.
  expect(beforeLoad.equals(afterLoad)).toBe(false);
});
