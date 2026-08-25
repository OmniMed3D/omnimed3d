import { expect, test } from "@playwright/test";

/**
 * REQ-C03 first slice: a known-answer synthetic volume + a known-answer
 * mask, checking that the rendered output places the mask overlay at the
 * geometrically correct location -- not a segmentation-accuracy check
 * (that's the AI track's half of REQ-C03), and not a Vulkan-vs-WebGPU
 * backend diff (`claude.md` §6 directory map already corrects that
 * mischaracterization). See docs/current/TESTS_PARITY_TODO_2026-08-24.md
 * §2 for why this lives here (real WebGPU render output is the only way
 * to catch a coordinate-flip bug -- `WebGPUDevice::applyMaskSlice` itself
 * does no coordinate transform to unit-test natively) rather than under
 * `engine/tests/parity/` as a native CTest.
 *
 * Bypasses the DICOM parser and Inference Worker entirely (this isn't
 * real patient data or real inference output) by calling
 * `_engine_load_volume`/`_engine_apply_mask_slice` directly, same
 * direct-injection technique `shell-mask-integration.spec.ts` and
 * `mask-opacity-controls.spec.ts` already use for a real DICOM volume.
 *
 * Uses the 2D axial slice view (not 3D orbit raymarch) specifically
 * because its screen<->voxel mapping is a single, known "contain" fit
 * formula (`axial_slice.slang`'s fitParams), not a perspective camera --
 * a square volume physical aspect matched to a square viewport makes
 * that fit an identity (fitScaleX=fitScaleY=1), so canvas pixel (px,py)
 * maps to volume UV ((px+0.5)/W, (py+0.5)/H) with no rotation/mirroring
 * unaccounted for. HU=0 everywhere (encodes to the all-zero float16 bit
 * pattern, so the raw Uint16Array volume buffer needs no conversion) sits
 * exactly at the default window center, giving a uniform background with
 * no HU-driven color variation -- the only thing that can make two
 * sample regions differ is the mask overlay.
 *
 * Reads pixels via clipped `page.screenshot()` (the same real-render
 * capture `mask-opacity-controls.spec.ts` already relies on), not a
 * page-JS `drawImage(sourceCanvas, ...)` readback -- that route was
 * tried first and empirically always returned a fully transparent
 * buffer for this WebGPU-backed canvas (confirmed via a throwaway debug
 * script, not assumed), so it can't be used here. The control panel is
 * collapsed first since it's an opaque DOM overlay covering most of the
 * viewport -- `page.screenshot()` captures the composited page, not the
 * canvas element's own backing store.
 */

const VOLUME_ID = 777;
const VOLUME_SIZE = 64; // width == height == depth-irrelevant square slice
const CANVAS_SIZE = 640; // square viewport -> volume/canvas aspect both 1:1
const QUARTER = CANVAS_SIZE / 4;
const THREE_QUARTERS = CANVAS_SIZE - QUARTER;
const SAMPLE_BOX = 40;

async function clipAt(page: import("@playwright/test").Page, cx: number, cy: number): Promise<Buffer> {
  return page.screenshot({
    clip: { x: cx - SAMPLE_BOX / 2, y: cy - SAMPLE_BOX / 2, width: SAMPLE_BOX, height: SAMPLE_BOX },
  });
}

test("known-answer synthetic mask renders at the geometrically correct quadrant, not flipped/rotated", async ({
  page,
}) => {
  await page.setViewportSize({ width: CANVAS_SIZE, height: CANVAS_SIZE });

  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await page.locator('[data-view-mode="1"]').click();

  await page.evaluate(
    ({ volumeId, size }) => {
      const voxelCount = size * size; // depth=1
      const huBytes = new Uint8Array(voxelCount * 2); // HU=0 everywhere -> all-zero float16 bits
      const ptr = window.Module._malloc(huBytes.length);
      window.Module.HEAPU8.set(huBytes, ptr);
      window.Module._engine_load_volume(volumeId, ptr, huBytes.length, size, size, 1, 1.0, 1.0, 1.0, 1);
      window.Module._free(ptr);
    },
    { volumeId: VOLUME_ID, size: VOLUME_SIZE },
  );
  await waitForLine(new RegExp(`WebGPUDevice::loadVolume: volumeId=${VOLUME_ID} `));

  // Known-answer mask: class 1 in the top-left quadrant only, class 0
  // everywhere else -- asymmetric on both axes, so a horizontal flip,
  // vertical flip, or 180-degree rotation bug each land the highlight in
  // a *different* wrong quadrant, all four of which are checked below.
  await page.evaluate(
    ({ volumeId, size }) => {
      const mask = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          mask[y * size + x] = x < size / 2 && y < size / 2 ? 1 : 0;
        }
      }
      const ptr = window.Module._malloc(mask.length);
      window.Module.HEAPU8.set(mask, ptr);
      window.Module._engine_apply_mask_slice(volumeId, 0, size, size, ptr, mask.length);
      window.Module._free(ptr);
    },
    { volumeId: VOLUME_ID, size: VOLUME_SIZE },
  );
  await waitForLine(new RegExp(`WebGPUDevice::applyMaskSlice: volumeId=${VOLUME_ID} slice=0 applied`));

  await page.locator("#panel-collapse-toggle").click();
  await page.waitForTimeout(500);

  const topLeft = await clipAt(page, QUARTER, QUARTER);
  const topRight = await clipAt(page, THREE_QUARTERS, QUARTER);
  const bottomLeft = await clipAt(page, QUARTER, THREE_QUARTERS);
  const bottomRight = await clipAt(page, THREE_QUARTERS, THREE_QUARTERS);

  // The only quadrant carrying the known-answer mask (class 1) must look
  // different from each of the other three -- lerp'd toward
  // kMaskHighlightColor vs. plain background.
  expect(topLeft.equals(topRight)).toBe(false);
  expect(topLeft.equals(bottomLeft)).toBe(false);
  expect(topLeft.equals(bottomRight)).toBe(false);

  // The three unmasked quadrants (class 0 everywhere) must all render
  // identically -- if a coordinate bug misplaced the highlight into one
  // of these instead, this equality breaks even though the topLeft
  // checks above would still (spuriously) pass.
  expect(topRight.equals(bottomLeft)).toBe(true);
  expect(topRight.equals(bottomRight)).toBe(true);
});
