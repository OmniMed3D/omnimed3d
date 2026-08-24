import { expect, test } from "@playwright/test";

/**
 * Mobile OOM mitigation (Option B): WebGPU device-lost/uncaptured-error
 * handling. Previously, a real GPU-level failure (WebGPUDevice.cpp had
 * no deviceLostCallbackInfo/uncapturedErrorCallbackInfo registered at
 * all) failed completely silently -- the canvas would just freeze with
 * no explanation.
 *
 * Triggers via `_engine_debug_simulate_device_lost()`, a WASM-debug-only
 * export that runs the exact same `WebGPUDevice::onDeviceLost()` code
 * path a real Dawn-fired callback would (same reason/message plumbing,
 * same `renderFrame()` guard, same `getDeviceLossState()` result) --
 * see that function's own header comment for why this is used instead
 * of reaching into Emscripten's internal WebGPU handle table for a real
 * `GPUDevice.destroy()` call (undocumented/version-fragile internals).
 */

test("device-lost shows the reload banner and stops rendering", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await expect(page.locator("#device-lost-banner")).toBeHidden();
  expect(await page.evaluate(() => window.Module._engine_get_device_lost())).toBe(0);

  await page.evaluate(() => window.Module._engine_debug_simulate_device_lost());

  await expect(page.locator("#device-lost-banner")).toBeVisible();
  await expect(page.locator("#device-lost-banner-message")).toContainText("simulated for e2e testing");
  expect(await page.evaluate(() => window.Module._engine_get_device_lost())).toBe(1);

  // renderFrame()'s guard should now bail every frame -- not directly
  // observable from JS without a GPU readback, but the reload button
  // reaching a stable, still-clickable state after the loss (no JS
  // exception thrown from a subsequent frame trying to use stale
  // device_/queue_ handles) is itself part of what this test is
  // checking: the page stays alive and interactive, not crashed.
  await expect(page.locator("#device-lost-banner-reload")).toBeVisible();
});

test("device-lost banner's Reload button reloads the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await page.evaluate(() => window.Module._engine_debug_simulate_device_lost());
  await expect(page.locator("#device-lost-banner")).toBeVisible();

  await Promise.all([page.waitForNavigation(), page.locator("#device-lost-banner-reload").click()]);

  // A fresh reload re-runs main()'s startup sequence -- the engine
  // re-initializes, the banner is hidden again (fresh DOM), and the
  // device-lost state resets (a new WebGPUDevice instance).
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect(page.locator("#device-lost-banner")).toBeHidden();
  expect(await page.evaluate(() => window.Module._engine_get_device_lost())).toBe(0);
});
