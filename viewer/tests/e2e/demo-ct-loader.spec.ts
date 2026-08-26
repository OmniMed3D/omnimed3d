import { expect, test } from "@playwright/test";

/**
 * "Load Demo CT" DoD verification (user request, 2026-08-21) --
 * demoCtControls.ts's fetch-manifest-then-fetch-all-slices path actually
 * loads a real volume through the same engine_load_volume path the
 * file-picker uses, and shows the required CC BY 3.0 attribution.
 *
 * User request, 2026-08-26: now a 3-way toggle (one series each), so
 * "loaded" is asserted via the .active class (same idiom as
 * rendering-quality-controls.spec.ts/clinical-shading-controls.spec.ts's
 * preset-button checks) rather than a permanently-disabled button with
 * "Demo CT loaded" text -- #load-demo-ct (data-demo-ct-id="LIDC-IDRI-0001")
 * stays re-selectable afterward, matching its sibling series buttons.
 *
 * Requires `npm run sync-demo-ct` to have been run first (not run
 * automatically by this test, matching how the engine WASM build is a
 * manual prerequisite rather than test-triggered) -- without it,
 * `/demo-ct/LIDC-IDRI-0001/manifest.json` 404s and this test's first case
 * fails with the same error the second test asserts on intentionally.
 */

test("Load Demo CT loads a real volume and shows CC BY 3.0 attribution", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs: number): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const canvas = page.locator("#canvas");
  const beforeLoad = await canvas.screenshot();

  await page.locator("#load-demo-ct").click();
  await expect(page.locator("#load-demo-ct")).toBeDisabled();

  // 261 slices over the network takes materially longer than the 1-slice
  // CT_small.dcm fixture other specs load -- 60s covers a slow CI runner.
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/, 60000);
  await page.waitForTimeout(500);

  const afterLoad = await canvas.screenshot();
  expect(beforeLoad.equals(afterLoad)).toBe(false);

  await expect(page.locator("#load-demo-ct")).toBeEnabled();
  await expect(page.locator("#load-demo-ct")).toHaveClass(/active/);
  await expect(page.locator("#load-demo-ct .gauge-label")).toHaveText("Lung1");
  await expect(page.locator("#demo-ct-status")).toContainText("LIDC-IDRI");
  await expect(page.locator("#demo-ct-status")).toContainText("CC BY 3.0");

  // The full required citation text is behind the <details> disclosure,
  // not the always-visible summary line.
  const details = page.locator("#demo-ct-status details");
  await expect(details.locator("summary")).toHaveText("Attribution");
  await details.locator("summary").click();
  await expect(details).toContainText("Data From LIDC-IDRI");
  await expect(details).toContainText("National Cancer Institute");
});

test("a missing demo-ct manifest shows a sync-demo-ct hint, not a generic error", async ({ page }) => {
  await page.route("**/demo-ct/LIDC-IDRI-0001/manifest.json", (route) => route.fulfill({ status: 404 }));

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.locator("#load-demo-ct").click();

  const loadError = page.locator("#load-error");
  await expect(loadError).toBeVisible();
  await expect(loadError).toContainText("sync-demo-ct");

  // The button must re-enable so the user isn't stuck after a failure.
  await expect(page.locator("#load-demo-ct")).toBeEnabled();
  await expect(page.locator("#load-demo-ct")).not.toHaveClass(/active/);
  await expect(page.locator("#load-demo-ct .gauge-label")).toHaveText("Lung1");
});
