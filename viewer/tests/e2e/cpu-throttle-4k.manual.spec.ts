import { expect, test } from "@playwright/test";

/**
 * PRD §9 item 2 ("execution on 4x CPU-throttled environments... frame
 * rate performance documented per Section 4") -- re-measured at a
 * resolution that actually escapes vsync, per
 * `docs/current/PERF_BASELINE_2026-08-21.md` §2's own finding that
 * 1280x900 (the viewport §1's original CPU-throttle sweep used) is
 * capped at the display's own refresh rate regardless of throttle rate,
 * making that sweep's FPS numbers meaningless. §2 found 2560x1440
 * reliably GPU-bound on the reference desktop GPU; this file reuses that
 * resolution instead of 4K purely to keep frame times in a comfortable
 * range for a throttled CPU.
 *
 * NOT part of the regular CI/local suite -- tagged `@manual` (Playwright's
 * own `--grep`/`--grep-invert` tag convention) so CI's `--grep-invert
 * "@manual"` run skips it. Two other exclusion mechanisms were tried and
 * rejected first: renaming to drop the `.spec.ts` suffix (Playwright's
 * CLI refuses to run an explicitly-named file its own `testMatch`
 * pattern wouldn't have discovered on its own) and `playwright.config.ts`'s
 * `testIgnore` (excludes the file from *every* invocation, including an
 * explicit path argument -- there is no override). The tag is the only
 * one of the three that both excludes it from a bare run and stays
 * directly runnable by explicit path/title. Reports a wall-clock/
 * CDP-throttled measurement, not a pass/fail regression check, matching
 * the same "pure benchmark, not correctness" reasoning `ai-pipeline`'s
 * own `benchmark-inference-worker.yml` uses to keep its equivalent files
 * out of the per-PR path. Run explicitly:
 *
 *   npx playwright test tests/e2e/cpu-throttle-4k.manual.spec.ts
 *
 * Needs a real WebGPU adapter (this repo's standard e2e prerequisite --
 * see playwright.config.ts's own comment) and the demo CT synced
 * (`npm run sync-demo-ct`) beforehand, same as every other spec that
 * uses "Load Demo CT".
 *
 * Reads `_engine_get_fps()`/`_engine_get_avg_frame_time_ms()` directly
 * (the same WASM exports `statsOverlay.ts` displays) rather than parsing
 * overlay DOM text, and CDP's `Emulation.setCPUThrottlingRate` directly
 * (the same mechanism Chrome DevTools' own throttling dropdown uses) --
 * both match this project's established measurement methodology
 * (PERF_BASELINE_2026-08-21.md §1/§2), just automated instead of manual.
 */

const SETTLE_MS = 3000; // let temporal accumulation (§6.5) converge before reading

async function readStats(page: import("@playwright/test").Page): Promise<{ fps: number; frameMs: number }> {
  return page.evaluate(() => ({
    fps: window.Module._engine_get_fps(),
    frameMs: window.Module._engine_get_avg_frame_time_ms(),
  }));
}

test.describe("4x CPU throttle @ 2560x1440 (vsync-escaping resolution, PRD §9 item 2) @manual", () => {
  test.use({ viewport: { width: 2560, height: 1440 } });

  test("static and drag FPS at 1x vs 4x CPU throttle", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

    await page.locator("#load-demo-ct").click();
    await expect(page.locator("#load-demo-ct")).toHaveClass(/active/, { timeout: 60000 });
    await page.waitForTimeout(SETTLE_MS);

    const cdp = await page.context().newCDPSession(page);
    const canvas = page.locator("#canvas");
    const box = (await canvas.boundingBox())!;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    const results: Record<string, { fps: number; frameMs: number }> = {};

    for (const rate of [1, 4]) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await page.waitForTimeout(SETTLE_MS);

      results[`${rate}x static`] = await readStats(page);

      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + 80, centerY + 40, { steps: 20 });
      await page.waitForTimeout(1500); // let the drag-adaptive quality settle in and stabilize
      results[`${rate}x drag`] = await readStats(page);
      await page.mouse.up();

      await page.waitForTimeout(500); // let interaction-adaptive quality restore before the next rate
    }

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); // reset -- don't leak throttling past this test

    console.table(
      Object.entries(results).map(([condition, { fps, frameMs }]) => ({
        condition,
        FPS: fps.toFixed(1),
        "Frame (ms)": frameMs.toFixed(3),
      })),
    );

    // Sanity assertions only -- this test's real output is the table
    // above, meant to be read and transcribed into PERF_BASELINE by hand.
    for (const { fps } of Object.values(results)) {
      expect(fps).toBeGreaterThan(0);
    }
  });
});
