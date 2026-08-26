import { expect, test } from "@playwright/test";

/**
 * Mobile OOM mitigation, on top of Option A's gradient-texture skip: in
 * low-memory mode the volume/mask textures themselves are now also
 * shrunk in-plane (X/Y, depth untouched) -- see
 * engine/docs/MOBILE_OOM_DIAGNOSTIC_2026-08-25.md for why the earlier
 * unload/reload approach (PR #116) turned out not to be enough on its
 * own, and engine/docs/RENDERING_SPEC.md's matching Change History entry
 * for the actual design.
 *
 * Same direct-injection technique as mask-geometry-parity.spec.ts
 * (bypasses the DICOM parser and Inference Worker entirely -- this isn't
 * real patient data or real inference output): calls
 * `_engine_load_volume`/`_engine_apply_mask_slice` directly, with the
 * mask always sent at the *original* (non-downsampled) resolution, since
 * that's what a real AI Worker would do (it has no idea the Engine
 * downsamples internally).
 *
 * Two things checked, at both downsampleFactor=1 (off) and =4 (matches
 * the Shell's current default, viewer/src/shell/deviceTier.ts's
 * DEFAULT_DOWNSAMPLE_FACTOR):
 *   (a) the new `WebGPUDevice::volumeTexture` log line reports a smaller
 *       extent only when downsampleFactor > 1 (regression-catching, same
 *       reasoning as Option A's own gradientTexture log assertion --
 *       proves the downsample branch is actually taken, not just that
 *       nothing crashes);
 *   (b) the known-answer top-left-quadrant mask still renders in the
 *       correct quadrant at both factors (proves applyMaskSlice()'s
 *       original-resolution validation and its downsample-on-write path
 *       both work end to end, not just that loading doesn't reject it).
 */

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

test("low-memory mode downsamples the volume/mask textures, and the mask still lands in the correct quadrant", async ({
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
  // MPR feature (2026-08-27): Axial/Sagittal/Coronal now share
  // data-view-mode="1", disambiguated by data-slice-axis.
  await page.locator('[data-view-mode="1"][data-slice-axis="0"]').click();
  await page.locator("#panel-collapse-toggle").click();

  async function loadAndCheckQuadrant(volumeId: number, downsampleFactor: number): Promise<void> {
    await page.evaluate(
      ({ volumeId, size, downsampleFactor }) => {
        const voxelCount = size * size; // depth=1
        const huBytes = new Uint8Array(voxelCount * 2); // HU=0 everywhere -> all-zero float16 bits
        const ptr = window.Module._malloc(huBytes.length);
        window.Module.HEAPU8.set(huBytes, ptr);
        window.Module._engine_load_volume(
          volumeId,
          ptr,
          huBytes.length,
          size,
          size,
          1,
          1.0,
          1.0,
          1.0,
          downsampleFactor,
        );
        window.Module._free(ptr);
      },
      { volumeId, size: VOLUME_SIZE, downsampleFactor },
    );
    await waitForLine(new RegExp(`WebGPUDevice::loadVolume: volumeId=${volumeId} `));

    // Known-answer mask, always sent at the *original* VOLUME_SIZE
    // resolution regardless of downsampleFactor -- matches what a real AI
    // Worker would send, unaware of any internal downsampling.
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
      { volumeId, size: VOLUME_SIZE },
    );
    await waitForLine(new RegExp(`WebGPUDevice::applyMaskSlice: volumeId=${volumeId} slice=0 applied`));
    await page.waitForTimeout(500);

    const topLeft = await clipAt(page, QUARTER, QUARTER);
    const topRight = await clipAt(page, THREE_QUARTERS, QUARTER);
    const bottomLeft = await clipAt(page, QUARTER, THREE_QUARTERS);
    const bottomRight = await clipAt(page, THREE_QUARTERS, THREE_QUARTERS);

    expect(topLeft.equals(topRight)).toBe(false);
    expect(topLeft.equals(bottomLeft)).toBe(false);
    expect(topLeft.equals(bottomRight)).toBe(false);
    expect(topRight.equals(bottomLeft)).toBe(true);
    expect(topRight.equals(bottomRight)).toBe(true);
  }

  await loadAndCheckQuadrant(801, 1);
  const fullModeExtent = consoleLines.find((line) => /WebGPUDevice::volumeTexture: \d+x\d+x\d+/.test(line));
  expect(fullModeExtent).toBeTruthy();
  expect(fullModeExtent).toMatch(`WebGPUDevice::volumeTexture: ${VOLUME_SIZE}x${VOLUME_SIZE}x1 (downsampleFactor=1)`);

  const TEST_DOWNSAMPLE_FACTOR = 4; // matches the Shell's current default
  await loadAndCheckQuadrant(802, TEST_DOWNSAMPLE_FACTOR);
  const downsampledExtent = consoleLines.find((line) =>
    /WebGPUDevice::volumeTexture: \d+x\d+x\d+ \(downsampleFactor=4\)/.test(line),
  );
  expect(downsampledExtent).toBeTruthy();
  // Ceiling-divided by the requested factor -- asserts the *actual* chosen
  // extent is smaller, not just an echo of the input (same
  // regression-catching reasoning as Option A's own gradientTexture log
  // assertion).
  const downsampledSize = Math.ceil(VOLUME_SIZE / TEST_DOWNSAMPLE_FACTOR);
  expect(downsampledExtent).toMatch(
    `WebGPUDevice::volumeTexture: ${downsampledSize}x${downsampledSize}x1 (downsampleFactor=${TEST_DOWNSAMPLE_FACTOR})`,
  );
});
