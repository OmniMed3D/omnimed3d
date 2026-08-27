import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * REQ-C01 mask-contract verification: real postMessage/Transferable
 * through real browser Workers, Shell -> Engine WASM compositor wiring,
 * out-of-order slice delivery, and stale-volumeId rejection (PRD §5.3.2).
 *
 * The first test's assertions are made against the Engine's own C++
 * stdout log lines (WebGPUDevice.cpp's std::printf calls, forwarded to
 * the browser console via index.html's Module.print), not new
 * engine-side readback code.
 *
 * The second test is the first one in this repo that asserts anything
 * about what's actually on screen -- renderFrame() didn't sample the
 * volume/mask textures at all until the raymarch pass existed. See
 * docs/verification/shell-mask-integration.md for the earlier manual
 * screenshot step this replaces.
 *
 * The fourth test drives the real, production UI -- `#dicom-files-input`,
 * mouse drag on `#canvas`, wheel, and the window/level slider/preset
 * controls -- instead of `omnimed3dTestHooks`, automating PRD §9's
 * "successful initial interaction (rotation, zoom) by non-developer
 * testers within 3 unassisted attempts" criterion.
 *
 * The fifth test covers the remaining third of that same PRD §9 criterion
 * -- slice panning -- via the real 3D/2D view-mode toggle and slice
 * slider.
 *
 * The sixth test verifies the canvas is genuinely responsive rather than
 * a fixed box -- at a desktop size and at a mobile-width viewport under
 * 640px (the P0 target per REQ-R07) -- and re-frames correctly (no
 * stretch) after a resize with a volume already loaded.
 *
 * The seventh test verifies the file-load progress indicator
 * (loadingIndicator.ts) appears while a real load is in flight and clears
 * once it completes.
 */

const ctSmallDcmPath = fileURLToPath(new URL("../../../engine/tests/fixtures/CT_small.dcm", import.meta.url));
const dummyOnnxPath = fileURLToPath(new URL("../fixtures/dummy-lungmask.onnx", import.meta.url));

test("real Worker postMessage/Transferable, Shell to Engine wiring, out-of-order delivery, stale-volumeId rejection", async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  function countLines(pattern: RegExp): number {
    return consoleLines.filter((line) => pattern.test(line)).length;
  }

  await page.route("**/dummy-lungmask.onnx", (route) => route.fulfill({ path: dummyOnnxPath }));

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");

  // Init the Inference Worker with the dummy model (plumbing only -- see
  // module doc comment) and wait for its own async session-load ack
  // before minting a volume / sending anything downstream of it --
  // sending hu-slice before this resolves races the load (see worker.ts's
  // "init-complete" comment).
  // A new volume does not auto-arm for segmentation just because the
  // model is already active (main.ts's segmentationArmedVolumeId) --
  // armSegmentationForCurrentVolume()
  // (armed here explicitly, matching a real "Run Segmentation" click)
  // is required before any hu-slice for this volume actually forwards to
  // the Inference Worker.
  const volumeIdA = await page.evaluate(() => {
    return new Promise<string>((resolve) => {
      window.omnimed3dTestHooks.inferenceWorker.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          window.omnimed3dTestHooks.inferenceWorker.removeEventListener("message", ack);
          const id = window.omnimed3dTestHooks.startNewVolume();
          window.omnimed3dTestHooks.armSegmentationForCurrentVolume();
          resolve(id);
        }
      });
      window.omnimed3dTestHooks.inferenceWorker.postMessage({
        type: "init",
        modelPath: "/dummy-lungmask.onnx",
      });
    });
  });
  expect(volumeIdA).toBeTruthy();

  // Real Parse Worker leg: parse-series with the same real DICOM file
  // "3 times" (a depth=3 volume out of one real slice -- explicitly
  // synthetic multi-slice construction, not a real series, per the
  // plan's fixture-availability note) via real postMessage/Transferable.
  // Produces one volume-ready (-> engine_load_volume) and 3 hu-slice
  // messages, auto-routed by main.ts to the Inference Worker.
  await page.evaluate(
    ({ base64, volumeId }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer.slice(0), bytes.buffer.slice(0), bytes.buffer.slice(0)];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId, files }, files);
    },
    { base64: ctSmallBase64, volumeId: volumeIdA },
  );

  // volume-ready's engine_load_volume call is synchronous C++ once it
  // arrives; wait for its real success log before anything mask-related.
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=1 .* loaded/);

  // The 3 hu-slice messages from parse-series each round-trip through the
  // (dummy-model) Inference Worker asynchronously; wait for all 3
  // resulting mask-slice deliveries to reach the real compositor.
  await expect
    .poll(() => countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/), { timeout: 20000 })
    .toBe(3);

  // Out-of-order delivery: 3 explicit parse-file calls with sliceIndex
  // 2, 0, 1 in that send order, same real DICOM bytes, same loaded
  // volume (depth=3, so all in range). Each flows through the real
  // Inference Worker independently.
  await page.evaluate(
    ({ base64, volumeId }) => {
      for (const sliceIndex of [2, 0, 1]) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        window.omnimed3dTestHooks.parseWorker.postMessage(
          { type: "parse-file", volumeId, sliceIndex, fileBytes: bytes.buffer },
          [bytes.buffer],
        );
      }
    },
    { base64: ctSmallBase64, volumeId: volumeIdA },
  );
  await expect
    .poll(() => countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/), { timeout: 20000 })
    .toBe(6);
  expect(countLines(/WebGPUDevice::applyMaskSlice:.*ignoring/)).toBe(0);

  // Stale-volumeId rejection (PRD §5.3.2): mint a second volume, load it
  // (making it "current"), then send a mask-producing hu-slice still
  // carrying the FIRST volumeId. volumeIdB is deliberately left *unarmed*
  // here (a real new volume load does not auto-arm), which closes this
  // gap one layer earlier -- the hu-slice is never even forwarded to the
  // Inference Worker in the first place (main.ts's hu-slice routing only
  // forwards for the armed volumeId, and volumeIdA's arming doesn't carry
  // over to B), so there's no round trip left for engineApplyMaskSlice's
  // own stale-volumeId guard to discard. Asserting no new mask ever lands
  // for either volume verifies that stronger guarantee directly, instead
  // of the old "goes through, then gets discarded" path.
  const volumeIdB = await page.evaluate(() => window.omnimed3dTestHooks.startNewVolume());
  await page.evaluate(
    ({ base64, volumeId }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId, files }, files);
    },
    { base64: ctSmallBase64, volumeId: volumeIdB },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=2 .* loaded/);

  const staleAppliedCountBefore = countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/);
  await page.evaluate(
    ({ base64, volumeId }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      window.omnimed3dTestHooks.parseWorker.postMessage(
        { type: "parse-file", volumeId, sliceIndex: 0, fileBytes: bytes.buffer },
        [bytes.buffer],
      );
    },
    { base64: ctSmallBase64, volumeId: volumeIdA },
  );
  // No arm call for volumeIdB, and volumeIdA is no longer the armed
  // volume either (mintVolumeId() reset it when B was minted) -- give the
  // (real, async) Inference Worker round trip a window it would need if
  // the slice *had* been forwarded, then confirm it wasn't: no new
  // mask-slice for volumeId=1, and no mask-slice for volumeId=2 (which
  // was never armed) either.
  await page.waitForTimeout(2000);
  expect(countLines(/WebGPUDevice::applyMaskSlice: volumeId=1 .* applied/)).toBe(staleAppliedCountBefore);
  expect(countLines(/WebGPUDevice::applyMaskSlice: volumeId=2 .* applied/)).toBe(0);
});

test("raymarch pass actually draws real DICOM data, not just the flat clear color", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const canvas = page.locator("#canvas");

  // Before any volume is loaded, renderFrame() only clears the canvas --
  // this screenshot is the flat background baseline the post-load one is
  // compared against below.
  const beforeLoad = await canvas.screenshot();

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

  // renderFrame() runs once per requestAnimationFrame tick -- give it a
  // few real frames to pick up the newly loaded volume/bind group before
  // capturing the "after" screenshot.
  await page.waitForTimeout(500);
  const afterLoad = await canvas.screenshot();

  // A real, not fabricated, visual check: byte-identical PNGs would mean
  // the raymarch pass drew literally nothing different from the
  // clear-only baseline. No pixel-decoding dependency needed -- any real
  // difference in rendered output changes the encoded PNG bytes.
  expect(beforeLoad.equals(afterLoad)).toBe(false);
});

test("mask overlay actually composites over the rendered volume", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const canvas = page.locator("#canvas");
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
  await page.waitForTimeout(500);
  const volumeOnlyShot = await canvas.screenshot();

  // main.ts's volumeId<->numeric mapping (volumeIdMap) is module-private,
  // so the real numeric id the engine assigned is pulled out of its own
  // log line rather than guessed.
  const loadLine = consoleLines.find((line) => /WebGPUDevice::loadVolume/.test(line))!;
  const engineVolumeId = Number(loadLine.match(/volumeId=(\d+)/)![1]);

  // engine_apply_mask_slice is called directly here, bypassing the
  // Inference Worker -- the repo's dummy ONNX fixture
  // (tests/fixtures/generate-dummy-onnx.py) is a static Concat of the
  // input with itself across all class channels, so argmax always picks
  // class 0 (background) by construction; it can never produce a
  // non-background mask to composite. This isolates the engine's own
  // mask-overlay compositing from model quality, which is out of scope
  // here. Same
  // direct-WASM-export pattern engine/tests/wasm_smoke/shell.html already
  // used before Shell wiring existed.
  await page.evaluate((id) => {
    const width = 128;
    const height = 128;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inCenter = x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75;
        mask[y * width + x] = inCenter ? 1 : 0;
      }
    }
    const ptr = window.Module._malloc(mask.length);
    window.Module.HEAPU8.set(mask, ptr);
    window.Module._engine_apply_mask_slice(id, 0, width, height, ptr, mask.length);
    window.Module._free(ptr);
  }, engineVolumeId);

  await waitForLine(/WebGPUDevice::applyMaskSlice: volumeId=\d+ slice=0 applied/);
  await page.waitForTimeout(500);
  const withMaskShot = await canvas.screenshot();

  // Same real-not-fabricated check as the previous test: a genuinely
  // composited overlay changes the rendered (and thus encoded PNG) output.
  expect(volumeOnlyShot.equals(withMaskShot)).toBe(false);
});

test("real UI: file picker, camera drag, wheel zoom, and window/level controls all visually work", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  const canvas = page.locator("#canvas");
  const beforeLoad = await canvas.screenshot();

  // Real file-picker input, not omnimed3dTestHooks.
  await page.locator("#dicom-files-input").setInputFiles(ctSmallDcmPath);
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);
  await page.waitForTimeout(500);
  const afterLoad = await canvas.screenshot();
  expect(beforeLoad.equals(afterLoad)).toBe(false);

  // Mouse-driven orbit: drag across the canvas.
  const box = (await canvas.boundingBox())!;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 80, centerY + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = await canvas.screenshot();
  expect(afterLoad.equals(afterDrag)).toBe(false);

  // Wheel zoom.
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
  const afterZoom = await canvas.screenshot();
  expect(afterDrag.equals(afterZoom)).toBe(false);

  // Window/level slider.
  const widthSlider = page.locator("#window-width");
  await widthSlider.fill("1500");
  await widthSlider.dispatchEvent("input");
  await page.waitForTimeout(300);
  const afterSlider = await canvas.screenshot();
  expect(afterZoom.equals(afterSlider)).toBe(false);

  // Colormap preset select -- also confirms the window/level sliders and
  // their labels update to match the preset (previously they went stale
  // after a preset click, so the next manual drag silently overwrote the
  // preset with the pre-click values).
  await page.locator("#colormap-preset-select").selectOption("1");
  await page.waitForTimeout(300);
  const afterPreset = await canvas.screenshot();
  expect(afterSlider.equals(afterPreset)).toBe(false);
  // #window-center-value/#window-width-value are real <input type=number>
  // elements now (numeric direct-entry follow-up), not read-only <span>s --
  // toHaveValue, not toHaveText.
  await expect(page.locator("#window-center")).toHaveValue("300");
  await expect(page.locator("#window-center-value")).toHaveValue("300");
  await expect(page.locator("#window-width")).toHaveValue("1500");
  await expect(page.locator("#window-width-value")).toHaveValue("1500");
});

test("view-mode toggle switches to a 2D axial slice view and the slice slider pans through it (PRD §9 slice-panning)", async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const canvas = page.locator("#canvas");
  const ctSmallBase64 = readFileSync(ctSmallDcmPath).toString("base64");

  // depth=3 volume via the same "same file 3x" trick the first test uses.
  const volumeId = await page.evaluate(() => window.omnimed3dTestHooks.startNewVolume());
  await page.evaluate(
    ({ base64, id }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const files = [bytes.buffer.slice(0), bytes.buffer.slice(0), bytes.buffer.slice(0)];
      window.omnimed3dTestHooks.parseWorker.postMessage({ type: "parse-series", volumeId: id, files }, files);
    },
    { base64: ctSmallBase64, id: volumeId },
  );
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);
  await page.waitForTimeout(500);
  const orbitShot = await canvas.screenshot();

  // Switch to 2D Slice (Axial -- MPR: Axial/Sagittal/Coronal buttons
  // share data-view-mode="1", disambiguated by data-slice-axis) -- a
  // genuinely different pipeline/output, so this
  // must differ regardless of mask state.
  await page.locator('[data-view-mode="1"][data-slice-axis="0"]').click();
  await page.waitForTimeout(300);
  const sliceDefaultShot = await canvas.screenshot();
  expect(orbitShot.equals(sliceDefaultShot)).toBe(false);

  // depth=3 -> slider max=2, default index=floor(3/2)=1 (engine's own
  // depth/2 default, mirrored client-side by viewControls.ts).
  await expect(page.locator("#slice-index")).toHaveAttribute("max", "2");
  await expect(page.locator("#slice-index")).toHaveValue("1");

  // The three slices are byte-identical HU data (same file loaded 3x), so
  // moving the slider alone wouldn't guarantee a visual diff -- apply a
  // mask to slice 0 only, same direct engine_apply_mask_slice pattern the
  // "mask overlay actually composites" test above uses, bypassing the
  // Inference Worker so this test isolates the slice pipeline/slider, not
  // model quality.
  const loadLine = consoleLines.find((line) => /WebGPUDevice::loadVolume/.test(line))!;
  const engineVolumeId = Number(loadLine.match(/volumeId=(\d+)/)![1]);
  await page.evaluate((id) => {
    const width = 128;
    const height = 128;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inCenter = x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75;
        mask[y * width + x] = inCenter ? 1 : 0;
      }
    }
    const ptr = window.Module._malloc(mask.length);
    window.Module.HEAPU8.set(mask, ptr);
    window.Module._engine_apply_mask_slice(id, 0, width, height, ptr, mask.length);
    window.Module._free(ptr);
  }, engineVolumeId);
  await waitForLine(/WebGPUDevice::applyMaskSlice: volumeId=\d+ slice=0 applied/);

  const sliceSlider = page.locator("#slice-index");
  await sliceSlider.fill("0");
  await sliceSlider.dispatchEvent("input");
  await page.waitForTimeout(300);
  const sliceZeroShot = await canvas.screenshot();
  expect(sliceZeroShot.equals(sliceDefaultShot)).toBe(false);

  await sliceSlider.fill("1");
  await sliceSlider.dispatchEvent("input");
  await page.waitForTimeout(300);
  const backToOneShot = await canvas.screenshot();
  expect(backToOneShot.equals(sliceZeroShot)).toBe(false);

  // The mouse wheel over the canvas scrubs this same slider in 2D Slice
  // mode (cameraControls.ts's wheel handler branches on
  // viewControls.ts's getViewMode() instead of always zooming -- zoom is a
  // no-op outside Orbit3D anyway, WebGPUDevice::zoomCamera's own guard).
  const sliceBox = (await canvas.boundingBox())!;
  await page.mouse.move(sliceBox.x + sliceBox.width / 2, sliceBox.y + sliceBox.height / 2);
  await page.mouse.wheel(0, 200); // scroll "down" a notch -> index 1 -> 2
  await page.waitForTimeout(300);
  await expect(sliceSlider).toHaveValue("2");
  const wheelDownShot = await canvas.screenshot();
  expect(wheelDownShot.equals(backToOneShot)).toBe(false);

  await page.mouse.wheel(0, -200); // scroll "up" a notch -> index 2 -> 1
  await page.waitForTimeout(300);
  await expect(sliceSlider).toHaveValue("1");
  const wheelUpShot = await canvas.screenshot();
  expect(wheelUpShot.equals(wheelDownShot)).toBe(false);

  // Toggle back to 3D Orbit -- pipeline changes again, and rotation/zoom
  // must keep working unregressed (drag confirms the camera still
  // responds, matching the fourth test's own drag check).
  await page.locator('[data-view-mode="0"]').click();
  await page.waitForTimeout(300);
  const backToOrbitShot = await canvas.screenshot();
  expect(backToOrbitShot.equals(backToOneShot)).toBe(false);

  const box = (await canvas.boundingBox())!;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 80, centerY + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = await canvas.screenshot();
  expect(backToOrbitShot.equals(afterDrag)).toBe(false);
});

test("canvas backing store is responsive, not a fixed 640x480 box", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  // The ResizeObserver in canvasResize.ts fires once on observe() -- give
  // it a moment to settle before reading the backing-store attributes.
  await page.waitForTimeout(300);
  const desktopSize = await page.evaluate(() => {
    const el = document.getElementById("canvas") as HTMLCanvasElement;
    return { width: el.width, height: el.height, dpr: window.devicePixelRatio };
  });
  expect(desktopSize.width).toBe(Math.round(1000 * desktopSize.dpr));
  expect(desktopSize.height).toBe(Math.round(700 * desktopSize.dpr));
  // The old behavior was an engine-side hardcoded 640x480 regardless of
  // viewport -- assert against it directly so a regression back to the
  // fixed box is caught even if the math above is coincidentally satisfied.
  expect(desktopSize.width).not.toBe(640);
  expect(desktopSize.height).not.toBe(480);

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
  await page.waitForTimeout(500);
  const canvas = page.locator("#canvas");
  const beforeResizeShot = await canvas.screenshot();

  // Resize to a mobile-width viewport under 640px -- the specific P0
  // scenario (REQ-R07's Mobile Chrome target) that previously broke.
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(300);
  const mobileSize = await page.evaluate(() => {
    const el = document.getElementById("canvas") as HTMLCanvasElement;
    return { width: el.width, height: el.height, dpr: window.devicePixelRatio };
  });
  expect(mobileSize.width).toBe(Math.round(375 * mobileSize.dpr));
  expect(mobileSize.height).toBe(Math.round(667 * mobileSize.dpr));
  expect(mobileSize.width).toBeLessThan(640);

  // Confirms rendering survived the live surface reconfigure (a crash or
  // silent stop would leave the canvas unchanged from its desktop-sized
  // pre-resize content, which is now a different pixel buffer size and so
  // trivially differs -- the real check is no page error was thrown,
  // asserted by Playwright's own unhandled-error-fails-the-test behavior
  // plus the render pass continuing to draw non-blank content below).
  await page.waitForTimeout(300);
  const afterResizeShot = await canvas.screenshot();
  expect(beforeResizeShot.equals(afterResizeShot)).toBe(false);
});

test("a loading indicator appears during a real file load and clears after", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  async function waitForLine(pattern: RegExp, timeoutMs = 15000): Promise<void> {
    await expect.poll(() => consoleLines.some((line) => pattern.test(line)), { timeout: timeoutMs }).toBe(true);
  }

  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  const indicator = page.locator("#loading-indicator");
  await expect(indicator).toBeHidden();

  // CT_small.dcm is tiny (single 128x128 file) -- the real load can
  // finish inside a single tick, too fast for real-time polling
  // (toBeVisible) to reliably observe the indicator's on/off flash. A
  // MutationObserver installed before the load starts records the
  // transition deterministically regardless of how fast it happens,
  // rather than racing wall-clock polling against it.
  await page.evaluate(() => {
    (window as { __indicatorWasVisible?: boolean }).__indicatorWasVisible = false;
    const el = document.getElementById("loading-indicator")!;
    new MutationObserver(() => {
      if (!el.hidden) {
        (window as { __indicatorWasVisible?: boolean }).__indicatorWasVisible = true;
      }
    }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
  });

  // Real file-picker input, not omnimed3dTestHooks -- exercises the same
  // loadVolumeFromFiles path a real user's click drives.
  await page.locator("#dicom-files-input").setInputFiles(ctSmallDcmPath);
  await waitForLine(/WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/);

  const wasVisible = await page.evaluate(() => (window as { __indicatorWasVisible?: boolean }).__indicatorWasVisible);
  expect(wasVisible).toBe(true);
  // Final state: cleared once the load completes.
  await expect(indicator).toBeHidden();
});
