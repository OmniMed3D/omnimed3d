import { expect, test } from "@playwright/test";

/**
 * User request, 2026-08-26: Low-Memory Mode pauses rendering for the
 * duration of each inference batch (renderPauseBanner.ts,
 * render-pause-during-inference.spec.ts) and runs against downsampled
 * textures (volume-downsample-low-memory-mode.spec.ts) -- without a
 * heads-up, that combination reads as "stuck" to a first-time user
 * clicking Load Segmentation Model. inferenceControls.ts's click handler
 * writes a notice into #demo-model-status (shouldUseLowMemoryMode()) --
 * verified here via the real click, not the underlying flag directly, so
 * a regression in the wiring (not just the detection logic, already
 * covered by device-tier-low-memory.spec.ts) would actually fail this.
 */

test("Low-Memory Mode shows a slower-inference notice when Load Segmentation Model is clicked", async ({ page }) => {
  await page.goto("/?lowMemory=1");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.locator("#load-demo-model").click();
  await expect(page.locator("#demo-model-status")).toHaveText(/Low-Memory Mode is on/);
});

test("outside Low-Memory Mode, no slower-inference notice appears", async ({ page }) => {
  await page.goto("/?lowMemory=0");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.locator("#load-demo-model").click();
  await expect(page.locator("#demo-model-status")).not.toHaveText(/Low-Memory Mode is on/);
});
