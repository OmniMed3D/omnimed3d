import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Drag-and-drop DICOM loading (dragAndDropControls.ts), alongside the
 * existing "Load DICOM folder"/"Load DICOM files" pickers.
 *
 * Real OS-level drag-and-drop (a native file/folder drag from the
 * desktop) can't be driven directly from Playwright/CDP -- these tests
 * build a `DataTransfer` in-page (`new DataTransfer()` +
 * `items.add(file)`) and dispatch synthetic `dragenter`/`dragleave`/
 * `drop` `DragEvent`s at `window`, the same target dragAndDropControls.ts
 * itself listens on. Confirmed directly (see this file's own
 * verification notes) that a `File` added this way has no real
 * `webkitGetAsEntry()`-backed filesystem entry (returns null, since
 * there's no actual OS drag session behind it) -- these tests therefore
 * exercise the flat-file fallback path (`item.getAsFile()`), not the
 * recursive folder-walk path (`FileSystemDirectoryReader`), which needs
 * a real OS folder drag to reach and isn't covered by automated e2e here.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));

async function dispatchDragEvent(
  page: import("@playwright/test").Page,
  type: "dragenter" | "dragleave" | "drop",
  withFiles: boolean,
): Promise<void> {
  await page.evaluate(
    ({ type, withFiles, base64 }) => {
      let dt = (window as unknown as { __dt?: DataTransfer }).__dt;
      if (!dt) {
        dt = new DataTransfer();
        if (withFiles) {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const file = new File([bytes], "CT_small.dcm", { type: "application/dicom" });
          dt.items.add(file);
        }
        (window as unknown as { __dt: DataTransfer }).__dt = dt;
      }
      window.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { type, withFiles, base64: readFileSync(ctSmallDcmPath).toString("base64") },
  );
}

test.afterEach(async ({ page }) => {
  // Clear the shared DataTransfer between tests -- otherwise a later
  // test's "no files" dragenter would reuse an earlier test's file-laden
  // one instead of building a fresh empty one.
  await page.evaluate(() => delete (window as unknown as { __dt?: DataTransfer }).__dt);
});

test("dragenter with files shows the drop overlay; without files, it doesn't", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await dispatchDragEvent(page, "dragenter", false);
  await expect(page.locator("#drop-overlay")).toBeHidden();

  await page.evaluate(() => delete (window as unknown as { __dt?: DataTransfer }).__dt);
  await dispatchDragEvent(page, "dragenter", true);
  await expect(page.locator("#drop-overlay")).toBeVisible();
  await expect(page.locator("#drop-overlay p")).toHaveText("Drop DICOM files or a folder to load");
});

test("dragenter/dragleave depth counter keeps the overlay visible while crossing nested elements", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  // Simulates the pointer entering the page, then entering a nested
  // child element (a second dragenter bubbles up before the parent's own
  // dragleave would otherwise fire) -- depth reaches 2.
  await dispatchDragEvent(page, "dragenter", true);
  await dispatchDragEvent(page, "dragenter", true);
  await expect(page.locator("#drop-overlay")).toBeVisible();

  // Leaving the child back into the parent -- depth drops to 1, still
  // over the page overall, so the overlay must stay up.
  await dispatchDragEvent(page, "dragleave", true);
  await expect(page.locator("#drop-overlay")).toBeVisible();

  // Actually leaving the page/window -- depth reaches 0.
  await dispatchDragEvent(page, "dragleave", true);
  await expect(page.locator("#drop-overlay")).toBeHidden();
});

test("dropping a file loads it as a real volume and hides the overlay", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const canvas = page.locator("#canvas");
  const beforeLoad = await canvas.screenshot();

  await dispatchDragEvent(page, "dragenter", true);
  await expect(page.locator("#drop-overlay")).toBeVisible();

  await dispatchDragEvent(page, "drop", true);
  await expect(page.locator("#drop-overlay")).toBeHidden();

  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);
  await page.waitForTimeout(300);
  const afterLoad = await canvas.screenshot();
  expect(beforeLoad.equals(afterLoad)).toBe(false);
});
