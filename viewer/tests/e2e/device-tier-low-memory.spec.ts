import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Mobile OOM mitigation, C-3: `deviceTier.ts`'s `shouldUseLowMemoryMode()`
 * decides Option A's `lowMemoryMode` argument automatically from
 * `navigator.deviceMemory` (<=4GB -> low-memory), falls back to a UA
 * sniff for iOS specifically (the one exception to this codebase's
 * feature-detection preference, since Apple doesn't implement the Device
 * Memory API at all -- no feature-detectable signal exists there), and
 * accepts a `?lowMemory=1`/`?lowMemory=0` URL override ahead of both
 * (same diagnostic-override pattern as canvasResize.ts's `?dpr=<n>`).
 *
 * Each scenario stubs `navigator.deviceMemory`/`navigator.userAgent` via
 * `page.addInitScript()` (must run before any page script reads them,
 * hence before `page.goto()`), then drives a REAL volume load through
 * `main.ts`'s `engineLoadVolume()` -- not a direct `_engine_load_volume`
 * injection, which would bypass `shouldUseLowMemoryMode()` entirely and
 * defeat the point of this test. Uses the small `CT_small.dcm` fixture
 * (not the full demo CT) via the same real Parse Worker
 * postMessage/Transferable path `shell-mask-integration.spec.ts` and
 * `mask-opacity-controls.spec.ts` already use, for speed.
 *
 * Wraps the real `_engine_load_volume` WASM export to record its actual
 * `lowMemoryMode` argument (the `mobile-render-perf.spec.ts` technique)
 * rather than inferring it indirectly, and separately checks the
 * `#stat-low-memory-value` debug-overlay row `notifyLowMemoryMode()`
 * writes -- covering both the decision itself and its one piece of UI
 * surfacing.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));

async function stubDeviceMemory(page: import("@playwright/test").Page, value: number | undefined): Promise<void> {
  await page.addInitScript((v) => {
    Object.defineProperty(navigator, "deviceMemory", { get: () => v, configurable: true });
  }, value);
}

async function stubUserAgent(page: import("@playwright/test").Page, value: string): Promise<void> {
  await page.addInitScript((v) => {
    Object.defineProperty(navigator, "userAgent", { get: () => v, configurable: true });
  }, value);
}

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function loadCtSmallAndCaptureLowMemoryMode(
  page: import("@playwright/test").Page,
  urlSuffix = "",
  beforeLoad?: (page: import("@playwright/test").Page) => Promise<void>,
): Promise<{ calledWith: number[]; statText: string | null }> {
  await page.goto(`/${urlSuffix}`);
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  if (beforeLoad) {
    await beforeLoad(page);
  }

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

  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");
  const volumeId = await page.evaluate(() => window.omnimed3dTestHooks.startNewVolume());
  await page.evaluate(
    ({ base64, id }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId: id, files }, files);
    },
    { base64: ctSmallBase64, id: volumeId },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);

  const calledWith = await page.evaluate(() => (window as unknown as { __loadCalls: number[] }).__loadCalls);
  const statText = await page.locator("#stat-low-memory-value").textContent();
  return { calledWith, statText };
}

test("navigator.deviceMemory above the threshold loads in full mode", async ({ page }) => {
  await stubDeviceMemory(page, 8);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page);
  expect(calledWith).toEqual([0]);
  expect(statText).toBe("OFF");
});

test("navigator.deviceMemory at or below the threshold loads in low-memory mode", async ({ page }) => {
  await stubDeviceMemory(page, 2);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page);
  expect(calledWith).toEqual([1]);
  expect(statText).toBe("ON");
});

test("deviceMemory absent + iOS user agent falls back to low-memory mode", async ({ page }) => {
  await stubDeviceMemory(page, undefined);
  await stubUserAgent(page, IOS_UA);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page);
  expect(calledWith).toEqual([1]);
  expect(statText).toBe("ON");
});

test("deviceMemory absent + non-iOS user agent stays in full mode", async ({ page }) => {
  await stubDeviceMemory(page, undefined);
  await stubUserAgent(page, DESKTOP_UA);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page);
  expect(calledWith).toEqual([0]);
  expect(statText).toBe("OFF");
});

test("?lowMemory=1 forces low-memory mode even when deviceMemory says otherwise", async ({ page }) => {
  await stubDeviceMemory(page, 8);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page, "?lowMemory=1");
  expect(calledWith).toEqual([1]);
  expect(statText).toBe("ON");
});

test("?lowMemory=0 forces full mode even when deviceMemory says otherwise", async ({ page }) => {
  await stubDeviceMemory(page, 2);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page, "?lowMemory=0");
  expect(calledWith).toEqual([0]);
  expect(statText).toBe("OFF");
});

test("Low-Memory Mode checkbox starts synced with the auto-detected default", async ({ page }) => {
  await stubDeviceMemory(page, 8);
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect(page.locator("#low-memory-mode-enabled")).not.toBeChecked();
});

test("checking the Low-Memory Mode checkbox overrides deviceMemory for the next load, even ahead of a ?lowMemory=0 URL param", async ({
  page,
}) => {
  // Deliberately contradicts both signals it should out-rank: deviceMemory
  // says "plenty of memory, full mode" and the URL param explicitly asks
  // for full mode too -- only the checkbox's own precedence (highest,
  // per deviceTier.ts's shouldUseLowMemoryMode()) should decide this.
  await stubDeviceMemory(page, 8);
  const { calledWith, statText } = await loadCtSmallAndCaptureLowMemoryMode(page, "?lowMemory=0", async (p) => {
    await expect(p.locator("#low-memory-mode-enabled")).not.toBeChecked();
    await p.locator("#low-memory-mode-enabled").check();
  });
  expect(calledWith).toEqual([1]);
  expect(statText).toBe("ON");
});
