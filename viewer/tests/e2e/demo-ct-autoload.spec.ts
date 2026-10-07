import { expect, test } from "@playwright/test";

/**
 * ?demo=<series-id> starts that demo series loading without a click -- the
 * landing page's "Open the demo" CTA links here. Requires
 * `npm run sync-demo-ct` (same prerequisite as demo-ct-loader.spec.ts).
 */

test("?demo=LIDC-IDRI-0001 loads that series without a click", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  await page.goto("/app/?demo=LIDC-IDRI-0001");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect
    .poll(() => consoleLines.some((line) => /WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/.test(line)), {
      timeout: 60000,
    })
    .toBe(true);
  await expect(page.locator("#load-demo-ct")).toHaveClass(/active/);
});

test("?demo= works alongside other query params", async ({ page }) => {
  await page.goto("/app/?lowMemory=1&demo=LIDC-IDRI-0002");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect(page.locator('[data-demo-ct-id="LIDC-IDRI-0002"]')).toHaveClass(/active/, { timeout: 60000 });
});

test("an unknown ?demo= id leaves the viewer idle", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/app/?demo=not-a-series");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await page.waitForTimeout(1000);

  const buttons = page.locator("[data-demo-ct-id]");
  for (let i = 0; i < (await buttons.count()); i++) {
    await expect(buttons.nth(i)).toBeEnabled();
    await expect(buttons.nth(i)).not.toHaveClass(/active/);
  }
  await expect(page.locator("#empty-hint")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("?demo= is removed from the URL once used, so a refresh doesn't reload the demo", async ({ page }) => {
  await page.goto("/app/?lowMemory=1&demo=LIDC-IDRI-0001");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect(page.locator("#load-demo-ct")).toHaveClass(/active/, { timeout: 60000 });
  const url = new URL(page.url());
  expect(url.searchParams.has("demo")).toBe(false);
  expect(url.searchParams.get("lowMemory")).toBe("1");
});
