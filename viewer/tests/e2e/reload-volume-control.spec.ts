import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * User request, 2026-08-26: Low-Memory Mode/Downsample Factor
 * (deviceTier.ts) only take effect at `_engine_load_volume` call time --
 * toggling either with a volume already on screen previously had no way
 * to actually re-apply short of re-picking the same file(s) from a
 * native dialog. reloadVolumeControl.ts's `#reload-volume` button redoes
 * the last load (file-picker or Demo CT) with whatever settings are
 * current now.
 *
 * Drives the real file-input -> filePicker.ts -> main.ts's
 * loadVolumeFromFiles() -> reloadVolumeControl.ts registration chain
 * end-to-end, then wraps the real `_engine_load_volume` WASM export
 * (the device-tier-low-memory.spec.ts technique) to prove the button's
 * click actually re-triggers a real load with the *new* downsampleFactor,
 * not just that the button exists.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));

test("Reload Volume is disabled until a volume loads, then re-applies a changed Low-Memory Mode setting", async ({
  page,
}) => {
  await page.goto("/?lowMemory=0");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await expect(page.locator("#reload-volume")).toBeDisabled();

  await page.evaluate(() => {
    (window as unknown as { __loadCalls: number[] }).__loadCalls = [];
    const real = window.Module._engine_load_volume.bind(window.Module);
    window.Module._engine_load_volume = (...args: Parameters<typeof real>) => {
      (window as unknown as { __loadCalls: number[] }).__loadCalls.push(args[9]);
      return real(...args);
    };
  });

  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.locator("#dicom-files-input").setInputFiles(ctSmallDcmPath);
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);

  await expect(page.locator("#reload-volume")).toBeEnabled();
  let calledWith = await page.evaluate(() => (window as unknown as { __loadCalls: number[] }).__loadCalls);
  expect(calledWith).toEqual([1]);

  // Rendering (which holds Low-Memory Mode) is nested inside the outer
  // "Advanced Mode" <details> -- see index.html.
  await page.locator("#advanced-mode-toggle").click();
  await page.locator("#rendering-toggle").click();
  await page.locator("#low-memory-mode-enabled").check();

  // Not waitForLine() again here -- the pattern already matched from the
  // first load above, so `.some()` would resolve instantly without
  // actually waiting for this second call. __loadCalls.length is the real
  // synchronization point: it only grows once the wrapped
  // _engine_load_volume has actually been invoked again.
  await page.locator("#reload-volume").click();
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as { __loadCalls: number[] }).__loadCalls)).length)
    .toBe(2);

  calledWith = await page.evaluate(() => (window as unknown as { __loadCalls: number[] }).__loadCalls);
  expect(calledWith).toEqual([1, 4]);
});

test("Reload Volume also works after Load Demo CT", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs: number): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await expect(page.locator("#reload-volume")).toBeDisabled();

  await page.locator("#load-demo-ct").click();
  // 133 slices over the network takes materially longer than CT_small.dcm
  // -- 60s covers a slow CI runner, matching demo-ct-loader.spec.ts.
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/, 60000);
  // Toggle behavior (2026-08-26): re-selectable, not permanently disabled --
  // .active is demoCtControls.ts's "this series is the one loaded" signal.
  await expect(page.locator("#load-demo-ct")).toBeEnabled();
  await expect(page.locator("#load-demo-ct")).toHaveClass(/active/);

  await expect(page.locator("#reload-volume")).toBeEnabled();

  await page.evaluate(() => {
    (window as unknown as { __loadCount: number }).__loadCount = 0;
    const real = window.Module._engine_load_volume.bind(window.Module);
    window.Module._engine_load_volume = (...args: Parameters<typeof real>) => {
      (window as unknown as { __loadCount: number }).__loadCount += 1;
      return real(...args);
    };
  });

  // Reload Volume lives inside Rendering, nested inside the outer
  // "Advanced Mode" <details> -- see index.html.
  await page.locator("#advanced-mode-toggle").click();
  await page.locator("#rendering-toggle").click();
  await page.locator("#reload-volume").click();
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __loadCount: number }).__loadCount), {
      timeout: 60000,
    })
    .toBe(1);
});
