import { expect, test } from "@playwright/test";

/**
 * Verifies tooltipManager.ts's hover/focus tooltips appear with the
 * right text and stay within the viewport, including near the panel's
 * edges where a naive CSS popup would get clipped by #control-panel's
 * own overflow-y:auto (see tooltipManager.ts's header comment for why
 * that clipping risk is real, not hypothetical).
 *
 * Desktop Chrome's Playwright project already satisfies
 * `(hover: hover) and (pointer: fine)`, so no separate mobile/touch
 * project is needed to confirm the feature is active here -- it's
 * deliberately scoped out of touch devices, see tooltipManager.ts.
 */

test("hovering a slider shows its tooltip with the expected text", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const tooltip = page.locator("#control-tooltip");
  await expect(tooltip).toBeHidden();

  await page.locator("#window-center").hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/window center/i);

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
});

test("keyboard focus shows the same tooltip as hover", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  // TF Detail is a collapsed <details> section by default, nested inside
  // the outer "Advanced Mode" <details> -- see index.html.
  await page.locator("#advanced-mode-toggle").click();
  await page.locator("#tf-detail-toggle").click();

  const tooltip = page.locator("#control-tooltip");
  await page.locator("#threshold").focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/density below this value/i);

  await page.locator("#threshold").blur();
  await expect(tooltip).toBeHidden();
});

test("tooltips near the panel's top and bottom edges stay within the viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const viewport = page.viewportSize()!;
  const tooltip = page.locator("#control-tooltip");

  // Near the top of the panel (Window Center is one of the first controls).
  await page.locator("#window-center").hover();
  await expect(tooltip).toBeVisible();
  let box = (await tooltip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

  // Near the bottom of the panel -- may require scrolling the panel into
  // view first since #control-panel scrolls internally. Clip is a
  // collapsed <details> section by default, nested inside the outer
  // "Advanced Mode" <details> -- see index.html.
  await page.locator("#advanced-mode-toggle").click();
  await page.locator("#clip-toggle").click();
  await page.locator("#clip-reset").scrollIntoViewIfNeeded();
  await page.locator("#clip-reset").hover();
  await expect(tooltip).toBeVisible();
  box = (await tooltip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});
