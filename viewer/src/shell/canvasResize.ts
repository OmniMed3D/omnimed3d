/**
 * Responsive canvas backing-store sizing -- the canvas fills
 * its viewport via CSS (style.css), but the actual pixel buffer
 * (width/height attributes) has to be set explicitly and kept in sync
 * with devicePixelRatio, or the render looks blurry (too few backing
 * pixels for the CSS size) or wastes GPU fill-rate (too many). A
 * ResizeObserver's callback fires once as soon as observe() is called,
 * with the element's current size -- this also handles the initial
 * sizing, no separate "set it once on startup" code path needed.
 *
 * Called only after waitForEngineReady() resolves (main.ts) -- the
 * observer calls window.Module._engine_resize directly, which does not
 * exist until the WASM runtime has initialized.
 */

// Raymarch cost scales close to linearly with backing pixel count
// (measured via GPU timestamp-query across a resolution sweep), and
// mobile devicePixelRatio commonly runs 2-4x. Passing DPR
// through uncapped means a high-DPR phone renders several times the
// pixels its own screen can even resolve, for no visible sharpness gain
// past this point -- capping trades away resolution beyond a
// diminishing-returns threshold, not real quality.
//
// Capped at 1 (not 2) based on a mobile A/B: 2 measured ~27fps, 1
// measured ~49fps -- nearly double, for a resolution difference this
// engine's volumetric raymarch (not text or sharp vector UI, where
// supersampling matters far more) makes much less perceptually visible
// on a small screen.
const MAX_DEVICE_PIXEL_RATIO = 1;

// Diagnostic-only override (?dpr=<n> on the URL), not a product-facing
// setting -- lets a device retest at a different effective DPR cap
// without a rebuild/redeploy cycle. Falls back to MAX_DEVICE_PIXEL_RATIO
// whenever the param is absent or not a finite positive number.
function resolveMaxDevicePixelRatio(): number {
  const override = Number(new URLSearchParams(location.search).get("dpr"));
  return Number.isFinite(override) && override > 0 ? override : MAX_DEVICE_PIXEL_RATIO;
}

export function setupCanvasResize(): void {
  const maxDpr = resolveMaxDevicePixelRatio();
  const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("canvasResize: #canvas not found in the DOM");
    return;
  }

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const cssWidth = entry.contentRect.width;
      const cssHeight = entry.contentRect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
      const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width === backingWidth && canvas.height === backingHeight) {
        continue;
      }
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      window.Module._engine_resize(backingWidth, backingHeight);
    }
  });
  observer.observe(canvas);
}
