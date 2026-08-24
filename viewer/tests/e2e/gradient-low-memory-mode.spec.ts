import { expect, test } from "@playwright/test";
import { float32ToFloat16 } from "../../src/workers/parse-worker/src/halfFloat.js";

/**
 * Mobile OOM mitigation (Option A): `_engine_load_volume`'s new trailing
 * `lowMemoryMode` argument skips baking the precomputed gradient volume
 * (a full-volume RGBA16Float texture, 4x the HU volume's own size --
 * 266MB for the demo CT) in favor of an on-the-fly per-step gradient in
 * the raymarch shader (`computeGradient()`, restored from before issue
 * #81's gradient-volume precompute). This is a "does the fallback path
 * actually produce real gradient-based shading" check, not a pixel-exact
 * parity check -- the two gradient computations aren't bit-identical
 * (forward-difference vs. a precomputed bake has its own documented
 * clamp-boundary-zeroing difference, see `gradient_bake.slang`'s header
 * comment), so shading output is expected to be *close*, not byte-equal.
 *
 * Volume is a solid sphere (one HU value) against a uniform background
 * (another HU value) -- deliberately NOT a smooth HU ramp. A ramp's
 * density-driven transfer-function color already varies continuously
 * across the frame on its own, which drowned out shading's much smaller
 * multiplicative contribution in an earlier version of this test (caught
 * via a broken-on-purpose mutation test that still passed -- both a
 * mean-absolute-difference check and an image-wide luminance-stddev
 * check stayed within threshold even with gradient sampling wired to
 * always read a zero-initialized dummy texture, because the ramp's own
 * color variation dominates any signal from shading). With a sphere,
 * density is uniform *within* the sphere and uniform in the background,
 * so any spatial luminance variation on the sphere's own surface must
 * come from shading (the default camera frames volumes off-axis --
 * `frameCameraForVolume()`'s 35deg yaw / 25deg pitch, "so shaded volumes
 * show visible form ... not a flat silhouette" -- specifically so a
 * lit/shadowed gradient across a curved surface like this is visible).
 *
 * Reads pixels via a data-URL `<img>` + `drawImage` + `getImageData`
 * decode of an already-captured `page.screenshot()` PNG buffer -- not a
 * live `drawImage(sourceCanvas)` read, which `mask-geometry-parity.spec.ts`
 * already found always returns fully transparent against this
 * WebGPU-backed canvas. Decoding a static PNG via `<img>` sidesteps that
 * entirely and needs no new npm dependency (no PNG-parsing library).
 */

const VOLUME_SIZE = 48;
const SPHERE_RADIUS = 16;
const BACKGROUND_HU = -160; // near the default window's low edge
const SPHERE_HU = 200; // near the default window's high edge
const CANVAS_SIZE = 480;
// Center crop, not the full canvas -- excludes letterbox/empty background
// pixels around the sphere, which would otherwise dilute the luminance
// variation signal the sphere's own shaded surface produces.
const CROP = { x: CANVAS_SIZE * 0.2, y: CANVAS_SIZE * 0.2, size: CANVAS_SIZE * 0.6 };

function buildSphereVolumeBase64(): string {
  const size = VOLUME_SIZE;
  const center = (size - 1) / 2;
  const voxels = size * size * size;
  const hu = new Uint16Array(voxels);
  const backgroundBits = float32ToFloat16(BACKGROUND_HU);
  const sphereBits = float32ToFloat16(SPHERE_HU);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - center;
        const dy = y - center;
        const dz = z - center;
        const inSphere = dx * dx + dy * dy + dz * dz <= SPHERE_RADIUS * SPHERE_RADIUS;
        hu[z * size * size + y * size + x] = inSphere ? sphereBits : backgroundBits;
      }
    }
  }
  return Buffer.from(hu.buffer).toString("base64");
}

// Asserting on rendered pixels alone can't tell "the fallback shades
// correctly" apart from "lowMemoryMode was silently ignored and both
// loads allocated/baked the real full-size texture" -- a pixel-only
// comparison would pass either way, leaving the actual OOM mitigation
// (does low-memory mode really skip the 266MB texture and its bake?)
// unverified. These two engine-side log lines report the *actual*
// C++-side branch taken (real chosen extent, real bake-or-skip), not an
// echo of the input flag, so asserting on them catches a regression
// where the branching logic itself silently stops honoring the flag.
// Deliberately NOT prefixed "WebGPUDevice::loadVolume:" -- several other
// e2e specs loosely search console lines for that exact substring
// (`.find((line) => /WebGPUDevice::loadVolume/.test(line))`, then parse
// `volumeId=` out of whatever they find first) and broke when an earlier
// version of these markers used that prefix, since `.find()` picked up
// this line instead of the real "volumeId=... loaded" one.
function expectedGradientMarkers(lowMemoryMode: 0 | 1): { extent: RegExp; bake: RegExp } {
  return lowMemoryMode === 1
    ? {
        extent: /WebGPUDevice::gradientTexture: 1x1x1/,
        bake: /WebGPUDevice::gradientTexture: bake skipped \(low-memory mode\)/,
      }
    : {
        extent: new RegExp(`WebGPUDevice::gradientTexture: ${VOLUME_SIZE}x${VOLUME_SIZE}x${VOLUME_SIZE}`),
        bake: /WebGPUDevice::gradientTexture: baked/,
      };
}

async function loadSphereVolume(
  page: import("@playwright/test").Page,
  volumeId: number,
  lowMemoryMode: 0 | 1,
  volumeBase64: string,
): Promise<void> {
  const consoleLines: string[] = [];
  const listener = (msg: import("@playwright/test").ConsoleMessage) => consoleLines.push(msg.text());
  page.on("console", listener);
  try {
    await page.evaluate(
      ({ id, size, base64, lowMemory }) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const ptr = window.Module._malloc(bytes.length);
        window.Module.HEAPU8.set(bytes, ptr);
        window.Module._engine_load_volume(id, ptr, bytes.length, size, size, size, 1.0, 1.0, 1.0, lowMemory);
        window.Module._free(ptr);
      },
      { id: volumeId, size: VOLUME_SIZE, base64: volumeBase64, lowMemory: lowMemoryMode },
    );
    await expect
      .poll(() => consoleLines.some((line) => new RegExp(`WebGPUDevice::loadVolume: volumeId=${volumeId} `).test(line)))
      .toBe(true);

    const { extent, bake } = expectedGradientMarkers(lowMemoryMode);
    expect(
      consoleLines.some((line) => extent.test(line)),
      `expected a "${extent}" log line for volumeId=${volumeId} (lowMemoryMode=${lowMemoryMode}); got: ${consoleLines.join("; ")}`,
    ).toBe(true);
    expect(
      consoleLines.some((line) => bake.test(line)),
      `expected a "${bake}" log line for volumeId=${volumeId} (lowMemoryMode=${lowMemoryMode}); got: ${consoleLines.join("; ")}`,
    ).toBe(true);
  } finally {
    page.off("console", listener);
  }
  await page.waitForTimeout(500);
}

async function decodeScreenshotCrop(page: import("@playwright/test").Page, png: Buffer): Promise<number[]> {
  return page.evaluate(
    async ({ base64, crop }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(crop.x, crop.y, crop.size, crop.size);
      return Array.from(imageData.data);
    },
    { base64: png.toString("base64"), crop: CROP },
  );
}

function meanAbsoluteDifference(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += Math.abs(a[i]! - b[i]!);
  }
  return total / a.length;
}

// The sphere's shaded surface should show real luminance variation
// (bright side facing the fixed light, darker side away from it) --
// a fallback that degenerates to flat/ambient-only shading (e.g.
// wrongly sampling a zero-initialized dummy gradient texture instead of
// computing on the fly) collapses that variation toward a near-constant
// value, since density is uniform across the whole sphere and this crop
// excludes the background, isolating shading as the only remaining
// source of variation.
function luminanceStdDev(pixels: number[]): number {
  const luminances: number[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    luminances.push(0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!);
  }
  const mean = luminances.reduce((sum, v) => sum + v, 0) / luminances.length;
  const variance = luminances.reduce((sum, v) => sum + (v - mean) ** 2, 0) / luminances.length;
  return Math.sqrt(variance);
}

test("low-memory gradient fallback renders real shading on a sphere, not flat/degenerate, no GPU errors", async ({
  page,
}) => {
  await page.setViewportSize({ width: CANVAS_SIZE, height: CANVAS_SIZE });

  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  // The control panel overlays most of the viewport at this canvas size --
  // collapse it first, or a canvas-clipped screenshot just captures the
  // panel's own static UI (mask-geometry-parity.spec.ts hit the same
  // issue first).
  await page.locator("#panel-collapse-toggle").click();

  const volumeBase64 = buildSphereVolumeBase64();

  await loadSphereVolume(page, 901, 0, volumeBase64);
  const fullModeShot = await page.locator("#canvas").screenshot();

  await loadSphereVolume(page, 902, 1, volumeBase64);
  const lowMemoryShot = await page.locator("#canvas").screenshot();

  const fullModePixels = await decodeScreenshotCrop(page, fullModeShot);
  const lowMemoryPixels = await decodeScreenshotCrop(page, lowMemoryShot);

  const diff = meanAbsoluteDifference(fullModePixels, lowMemoryPixels);
  // Not byte-equal (different gradient computations, see header comment)
  // but should be visually close -- empirically ~0.6 for the correct
  // implementation vs. ~5.9 for a deliberately-broken one (mutation
  // tested by temporarily swapping which branch each mode takes, so a
  // low-memory load samples the unbaked dummy gradientTex instead of
  // computing on the fly) -- comfortably separated by this threshold.
  expect(diff).toBeLessThan(3);

  const fullModeStdDev = luminanceStdDev(fullModePixels);
  const lowMemoryStdDev = luminanceStdDev(lowMemoryPixels);
  expect(fullModeStdDev, "sanity check: full-mode sphere shading should itself vary spatially").toBeGreaterThan(10);
  // Empirically ~99% of full-mode's stddev for the correct implementation
  // vs. ~67% for the mutation above (degenerate/flatter shading loses
  // real contrast, but isn't fully flat either, since the sphere's
  // silhouette edge alone still contributes some variation) -- 0.85 sits
  // clearly between the two, verified against both.
  expect(lowMemoryStdDev, "low-memory fallback shading looks flat/degenerate, not gradient-based").toBeGreaterThan(
    fullModeStdDev * 0.85,
  );

  expect(errors, `unexpected console errors: ${errors.join("; ")}`).toHaveLength(0);
});
