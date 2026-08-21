import { expect, test } from "@playwright/test";

/**
 * Regression test for a real data-loss bug (found via user report after
 * Issue #35): clicking "Load Demo CT" before "Load Segmentation Model"
 * finished loading silently dropped every hu-slice message that arrived in
 * that window -- permanently, with only a console.log as a trace, and no
 * code path ever revisited a dropped slice. A completely reasonable click
 * order (view the volume first, decide to segment it after) to lose all
 * mask data over.
 *
 * Uses the real lungmask model (not the plumbing-only dummy ONNX fixture
 * shell-mask-integration.spec.ts uses) and the real demo CT, in the exact
 * buggy click order, and listens on the Inference Worker's own message
 * stream directly (matching setupInferenceControls' addEventListener
 * pattern, not main.ts's own onmessage slot) to confirm mask-slice results
 * actually come back -- not just that the UI doesn't error.
 */

interface RecordedMaskSlice {
  sliceIndex: number;
  nonBackgroundPixels: number;
}

test("hu-slice messages sent before the model finishes loading are queued and still processed, not dropped", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  // Observe raw mask-slice traffic on the Inference Worker directly, the
  // same way setupInferenceControls() does (addEventListener alongside
  // main.ts's own onmessage, not replacing it) -- proves slices queued
  // before "init-complete" actually made it through the pipeline and back,
  // not just that no error was thrown.
  await page.evaluate(() => {
    (window as unknown as { __maskSlices: RecordedMaskSlice[] }).__maskSlices = [];
    window.omnimed3dTestHooks.inferenceWorker.addEventListener("message", (event: MessageEvent) => {
      const msg = event.data as { type: string; sliceIndex?: number; data?: ArrayBuffer };
      if (msg.type === "mask-slice" && msg.data) {
        const bytes = new Uint8Array(msg.data);
        let nonBackground = 0;
        for (const b of bytes) {
          if (b !== 0) {
            nonBackground++;
          }
        }
        (window as unknown as { __maskSlices: RecordedMaskSlice[] }).__maskSlices.push({
          sliceIndex: msg.sliceIndex ?? -1,
          nonBackgroundPixels: nonBackground,
        });
      }
    });
  });

  // The exact buggy click order: demo CT first, model second.
  await page.locator("#load-demo-ct").click();
  await expect(page.locator("#load-demo-ct")).toHaveText("Demo CT loaded", { timeout: 60000 });

  await page.locator("#load-demo-model").click();
  await expect(page.locator("#load-demo-model")).toHaveText("Segmentation model loaded", { timeout: 60000 });

  const getMaskSlices = () =>
    page.evaluate(() => (window as unknown as { __maskSlices: RecordedMaskSlice[] }).__maskSlices);

  // Wait for the queue to flush AND for real lung tissue to show up in at
  // least one processed slice, not just for the first slice to arrive --
  // this demo CT's early slices (top of the volume) are legitimately
  // all-background, so polling for "queue non-empty" alone would pass on
  // the very first (background-only) slice without proving the fix. At
  // ~200-250ms/slice (docs/verification/inference-worker.md §8.4, FP16 on
  // WebGPU) processing through to a slice with real lung tissue takes a few
  // seconds once the model is ready; 90s leaves generous headroom for a
  // slower CI runner or WASM fallback (~900ms+/slice).
  await expect
    .poll(
      async () => {
        const slices = await getMaskSlices();
        return slices.some((s) => s.nonBackgroundPixels > 0);
      },
      { timeout: 90000 },
    )
    .toBe(true);
});
