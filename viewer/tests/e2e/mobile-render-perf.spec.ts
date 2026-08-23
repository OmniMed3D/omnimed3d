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

test("camera drag forces occlusion off (restoring on release) but leaves shading alone (issue #81 follow-up)", async ({
  page,
}) => {
  // Precomputing the raymarch gradient at load time (issue #81's own
  // follow-up) made real shading (mode 1) cheap enough that it no longer
  // needs an interaction-time fallback -- qualityControls.ts stopped
  // dropping shading to its old flat approximation (mode 2) during a
  // drag, precisely to eliminate the brightness pop that approximation
  // itself couldn't quite avoid. Occlusion, unrelated to that change,
  // still drops during a drag.
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  // Occlusion defaults off -- turn it on first so "restored to 1 after
  // the drag" is unambiguous evidence of a real restore, not just both
  // states happening to read 0.
  await page.locator("#occlusion-enabled").check();

  await page.evaluate(() => {
    const w = window as unknown as { __shadingCalls: number[]; __occlusionCalls: number[] };
    w.__shadingCalls = [];
    w.__occlusionCalls = [];
    const realShading = window.Module._engine_set_shading_enabled.bind(window.Module);
    window.Module._engine_set_shading_enabled = (enabled: number) => {
      w.__shadingCalls.push(enabled);
      return realShading(enabled);
    };
    const realOcclusion = window.Module._engine_set_occlusion_enabled.bind(window.Module);
    window.Module._engine_set_occlusion_enabled = (enabled: number) => {
      w.__occlusionCalls.push(enabled);
      return realOcclusion(enabled);
    };
  });

  const canvas = page.locator("#canvas");
  const box = (await canvas.boundingBox())!;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 60, centerY + 30, { steps: 5 });

  const lastValue = (calls: number[]) => calls[calls.length - 1];
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as { __occlusionCalls: number[] };
        return w.__occlusionCalls[w.__occlusionCalls.length - 1];
      }),
    )
    .toBe(0);

  await page.mouse.up();

  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => (window as unknown as { __occlusionCalls: number[] }).__occlusionCalls);
      return lastValue(calls);
    })
    .toBe(1);

  // Shading must never have been called with anything but 1 (on) --
  // interaction never touches it now. notifyInteractionStart()/End() both
  // call applyEngineState() (which always re-asserts shading too, see its
  // own comment), so this list is non-empty by construction -- checked
  // explicitly rather than trusting a for-of over a possibly-empty array
  // to prove anything.
  const shadingCalls = await page.evaluate(() => (window as unknown as { __shadingCalls: number[] }).__shadingCalls);
  expect(shadingCalls.length).toBeGreaterThan(0);
  for (const mode of shadingCalls) {
    expect(mode).toBe(1);
  }
});
