import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md §4.1/§4.3 DoD
 * verification: the new Quality-tier buttons and Shading checkbox
 * (qualityControls.ts) actually change what the raymarch pass draws, the
 * same "real, not fabricated" screenshot-diff pattern
 * shell-mask-integration.spec.ts already uses (byte-identical PNGs would
 * mean the control's WASM export call had no visible effect).
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));

async function loadVolumeAndSettle(page: import("@playwright/test").Page): Promise<void> {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await page.locator("#dicom-files-input").setInputFiles(ctSmallDcmPath);
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);
  // Lets a few real accumulation frames settle at the default (Medium)
  // tier/shading-on state before the test's own baseline screenshot, so a
  // later control change isn't compared against a still-converging frame.
  await page.waitForTimeout(500);
}

test("quality tier buttons change the rendered frame (§4.1)", async ({ page }) => {
  await loadVolumeAndSettle(page);
  const canvas = page.locator("#canvas");

  await expect(page.locator('[data-quality-tier="1"]')).toHaveClass(/active/);

  const mediumShot = await canvas.screenshot();

  await page.locator('[data-quality-tier="0"]').click();
  await expect(page.locator('[data-quality-tier="0"]')).toHaveClass(/active/);
  await page.waitForTimeout(300);
  const lowShot = await canvas.screenshot();
  expect(mediumShot.equals(lowShot)).toBe(false);

  await page.locator('[data-quality-tier="2"]').click();
  await expect(page.locator('[data-quality-tier="2"]')).toHaveClass(/active/);
  await page.waitForTimeout(300);
  const highShot = await canvas.screenshot();
  expect(lowShot.equals(highShot)).toBe(false);
});

test("shading toggle changes the rendered frame (§4.3)", async ({ page }) => {
  await loadVolumeAndSettle(page);
  const canvas = page.locator("#canvas");

  const shadingCheckbox = page.locator("#shading-enabled");
  await expect(shadingCheckbox).toBeChecked();
  const shadedShot = await canvas.screenshot();

  await shadingCheckbox.uncheck();
  await page.waitForTimeout(300);
  const unshadedShot = await canvas.screenshot();
  expect(shadedShot.equals(unshadedShot)).toBe(false);

  await shadingCheckbox.check();
  await page.waitForTimeout(300);
  const reshadedShot = await canvas.screenshot();
  expect(unshadedShot.equals(reshadedShot)).toBe(false);
});

test("colormap presets render visibly different colors, not just window/level (§4.2)", async ({ page }) => {
  await loadVolumeAndSettle(page);
  const canvas = page.locator("#canvas");

  await page.locator('[data-colormap-preset="0"]').click(); // Lung -- cool blue
  await page.waitForTimeout(300);
  const lungShot = await canvas.screenshot();

  await page.locator('[data-colormap-preset="1"]').click(); // Bone -- warm ivory
  await page.waitForTimeout(300);
  const boneShot = await canvas.screenshot();
  expect(lungShot.equals(boneShot)).toBe(false);
});
