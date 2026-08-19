/**
 * Responsive canvas backing-store sizing (issue #40) -- the canvas fills
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

export function setupCanvasResize(): void {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("canvasResize: #canvas not found in the DOM");
    return;
  }

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const cssWidth = entry.contentRect.width;
      const cssHeight = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
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
