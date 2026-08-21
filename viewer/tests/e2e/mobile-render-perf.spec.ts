import { expect, test } from "@playwright/test";

/**
 * Regression tests for issue #69 (mobile render-cost reductions), added
 * after a real iPhone 14 Pro test showed the demo CT rendering at ~5.6fps
 * (178ms/frame) -- unusable. Two independent mechanisms, each verified
 * directly rather than just "the demo looks faster":
 *
 * - DPR cap (canvasResize.ts): a high-devicePixelRatio device must not
 *   get a backing-store resolution proportionally larger than
 *   MAX_DEVICE_PIXEL_RATIO's own cap, however high the real DPR reports.
 * - Interaction-adaptive quality (qualityControls.ts/cameraControls.ts):
 *   a camera drag must call engine_set_quality_tier(0) at drag start and
 *   restore the user's selected tier at drag end, verified by wrapping
 *   the real WASM export and recording actual calls -- not just that the
 *   rendered frame looks different.
 */

test("canvas backing resolution is capped, not proportional to a high devicePixelRatio", async ({ browser }) => {
  // Playwright's deviceScaleFactor context option is what actually drives
  // window.devicePixelRatio in Chromium (a plain window.devicePixelRatio
  // override via addInitScript does not affect the real backing-store
  // math this test needs to exercise), so a dedicated context is used
  // here instead of test.use() at file scope, which would apply it to
  // every test in this file.
  const context = await browser.newContext({ deviceScaleFactor: 4 });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const [cssWidth, cssHeight, dpr] = await page.evaluate(() => [
    window.innerWidth,
    window.innerHeight,
    window.devicePixelRatio,
  ]);
  expect(dpr).toBe(4); // sanity: the emulated high-DPR device actually took effect.

  const canvas = page.locator("#canvas");
  const backingWidth = await canvas.evaluate((el: HTMLCanvasElement) => el.width);
  const backingHeight = await canvas.evaluate((el: HTMLCanvasElement) => el.height);

  const MAX_DEVICE_PIXEL_RATIO = 1; // must match canvasResize.ts's own constant
  const expectedWidth = Math.round(cssWidth * MAX_DEVICE_PIXEL_RATIO);
  const expectedHeight = Math.round(cssHeight * MAX_DEVICE_PIXEL_RATIO);
  const uncappedWidth = Math.round(cssWidth * dpr);

  expect(backingWidth).toBe(expectedWidth);
  expect(backingHeight).toBe(expectedHeight);
  expect(backingWidth).toBeLessThan(uncappedWidth);

  await context.close();
});

test("camera drag drops the engine's active quality tier and restores it on release (issue #69)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  // Wrap the real WASM export rather than the UI button state -- the
  // button/active-tier styling deliberately keeps showing the user's own
  // selection throughout a drag (qualityControls.ts's own design), so
  // only the actual engine call reveals whether the interaction-adaptive
  // behavior fired.
  await page.evaluate(() => {
    (window as unknown as { __tierCalls: number[] }).__tierCalls = [];
    const real = window.Module._engine_set_quality_tier.bind(window.Module);
    window.Module._engine_set_quality_tier = (tier: number) => {
      (window as unknown as { __tierCalls: number[] }).__tierCalls.push(tier);
      return real(tier);
    };
  });

  // Select High (tier 2) first so the restored value after the drag is
  // unambiguous -- Medium (tier 1, the default) would be indistinguishable
  // from a no-op if the restore step were silently skipped.
  await page.locator('[data-quality-tier="2"]').click();

  const canvas = page.locator("#canvas");
  const box = (await canvas.boundingBox())!;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 60, centerY + 30, { steps: 5 });

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __tierCalls: number[] }).__tierCalls))
    .toContainEqual(0);

  await page.mouse.up();

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as { __tierCalls: number[] }).__tierCalls);
      return calls[calls.length - 1];
    })
    .toBe(2);
});
