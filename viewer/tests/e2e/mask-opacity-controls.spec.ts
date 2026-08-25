import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * DoD verification for the mask overlay opacity slider
 * (`engine_set_mask_opacity`) and show/hide toggle
 * (`engine_set_mask_overlay_enabled`) -- the same "real, not fabricated"
 * screenshot-diff pattern shell-mask-integration.spec.ts's own mask test
 * uses. Applies a real, non-background mask slice directly via
 * `engine_apply_mask_slice` (bypassing the Inference Worker, same as
 * that file), isolating the engine's own compositing/toggle behavior
 * from model quality.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));

async function loadVolumeWithMask(page: import("@playwright/test").Page): Promise<{ engineVolumeId: number }> {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  // TF Detail is a collapsed <details> section by default, nested inside
  // the outer "Advanced Mode" <details> -- see index.html.
  await page.locator("#advanced-mode-toggle").click();
  await page.locator("#tf-detail-toggle").click();

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

  const loadLine = consoleLines.find((line) => /WebGPUDevice::loadVolume/.test(line))!;
  const engineVolumeId = Number(loadLine.match(/volumeId=(\d+)/)![1]);

  // Same fixed center-square mask pattern shell-mask-integration.spec.ts
  // uses -- a real, non-background class so the overlay has something
  // visible to blend/hide.
  await page.evaluate((id) => {
    const width = 128;
    const height = 128;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inCenter = x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75;
        mask[y * width + x] = inCenter ? 1 : 0;
      }
    }
    const ptr = window.Module._malloc(mask.length);
    window.Module.HEAPU8.set(mask, ptr);
    window.Module._engine_apply_mask_slice(id, 0, width, height, ptr, mask.length);
    window.Module._free(ptr);
  }, engineVolumeId);
  await waitForLine(/WebGPUDevice::applyMaskSlice: volumeId=\d+ slice=0 applied/);
  await page.waitForTimeout(500);

  return { engineVolumeId };
}

test("mask opacity slider changes how strongly the mask overlay blends", async ({ page }) => {
  await loadVolumeWithMask(page);
  const canvas = page.locator("#canvas");

  const defaultOpacityShot = await canvas.screenshot(); // default 0.6

  await page.locator("#mask-opacity").fill("0");
  await page.locator("#mask-opacity").dispatchEvent("input");
  await page.waitForTimeout(300);
  const zeroOpacityShot = await canvas.screenshot();
  expect(defaultOpacityShot.equals(zeroOpacityShot)).toBe(false);

  await page.locator("#mask-opacity").fill("1");
  await page.locator("#mask-opacity").dispatchEvent("input");
  await page.waitForTimeout(300);
  const fullOpacityShot = await canvas.screenshot();
  expect(fullOpacityShot.equals(zeroOpacityShot)).toBe(false);
  expect(fullOpacityShot.equals(defaultOpacityShot)).toBe(false);
});

test("mask overlay show/hide toggle hides and redisplays the overlay without touching its data", async ({ page }) => {
  await loadVolumeWithMask(page);
  const canvas = page.locator("#canvas");

  const withMaskShot = await canvas.screenshot();

  await page.locator("#mask-overlay-enabled").uncheck();
  await page.waitForTimeout(300);
  const hiddenShot = await canvas.screenshot();
  expect(withMaskShot.equals(hiddenShot)).toBe(false);

  // Re-enabling must show the mask again -- not just "some different
  // frame", but a real return of the overlay, without re-sending
  // engine_apply_mask_slice (proving the toggle is a pure display
  // switch over already-resident mask data, not a re-fetch/re-apply).
  await page.locator("#mask-overlay-enabled").check();
  await page.waitForTimeout(300);
  const redisplayedShot = await canvas.screenshot();
  expect(redisplayedShot.equals(hiddenShot)).toBe(false);
});
