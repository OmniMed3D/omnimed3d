import { expect, test } from "@playwright/test";

/**
 * Regression test for a real Chrome-specific layout bug (user report,
 * 2026-08-26, "Advanced Mode" text sitting too close together): `.panel-
 * section`'s `display: flex; gap: 8px` (style.css) only ever reached a
 * <details> element's own box, not its actual row children -- Chrome
 * wraps every non-<summary> child of a <details> in an internal
 * `::details-content` box (a real pseudo-element,
 * `CSS.supports("selector(::details-content)")` confirms it), which
 * defaults to plain block layout unless it also gets the flex/gap rule.
 * Rows inside the always-open <div class="panel-section"> sections
 * (Volume/Segmentation/View/Window & Level) were never affected -- only
 * the <details>-based ones (Clip/Rendering/TF Detail/Background/Debug,
 * and the outer "Advanced Mode" wrapper itself) were sitting with a
 * measured 0px gap between rows before the fix, confirmed via a
 * throwaway getBoundingClientRect() script before writing style.css's
 * `.panel-section::details-content` rule.
 */

test("rows inside a <details> section get the same 8px gap as rows inside a plain <div> section", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.locator("#advanced-mode-toggle").click();
  await page.locator("#rendering-toggle").click();

  async function gapBelow(idA: string, idB: string): Promise<number> {
    const a = (await page.locator(`.row:has(#${idA})`).first().boundingBox())!;
    const b = (await page.locator(`.row:has(#${idB})`).first().boundingBox())!;
    return Math.round(b.y - (a.y + a.height));
  }

  // Baseline: a plain <div class="panel-section"> (Window & Level) --
  // never affected by this bug, included so a regression that breaks the
  // fix for *both* kinds of section still fails this assertion (not just
  // one that silently degrades the <details> case back to 0).
  expect(await gapBelow("window-center", "window-width")).toBe(8);

  // The actually-regression-prone case: rows inside a <details class="panel-section">.
  expect(await gapBelow("shading-enabled", "low-memory-mode-enabled")).toBe(8);
});
