/**
 * Interactive orbit camera (issue #34, REQ-R06) -- forwards raw mouse-drag
 * pixel deltas and normalized wheel direction directly to the engine's
 * `engine_orbit_camera`/`engine_zoom_camera` WASM exports every event, no
 * batching/queueing. That's safe specifically because `WebGPUDevice`
 * never uses ASYNCIFY (see its own `AllowSpontaneous` comment,
 * engine/src/rhi/backends/webgpu/src/WebGPUDevice.cpp) -- Mini-Engine-
 * reference's equivalent JS shell needed a `_pending`-command queue
 * gated on a `Module._wasmBusy` flag specifically to avoid re-entering a
 * suspended ASYNCIFY call stack, a constraint that doesn't exist here.
 *
 * Drag lifecycle matches Mini-Engine-reference's validated
 * Camera::rotate() usage: mousedown on the canvas starts a drag,
 * mousemove/mouseup are listened for on `window` (not just the canvas)
 * so a drag already in progress isn't dropped if the pointer leaves the
 * canvas bounds or the button is released outside it.
 */

export function setupCameraControls(): void {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("cameraControls: #canvas not found in the DOM");
    return;
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("mousedown", (event: MouseEvent) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event: MouseEvent) => {
    if (!dragging) {
      return;
    }
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    window.Module._engine_orbit_camera(dx, dy);
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  canvas.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      // Stop page scroll; normalize to +-1 per notch -- real wheel-event
      // deltaY magnitude is inconsistent across browsers/devices
      // (DOM_DELTA_PIXEL vs DOM_DELTA_LINE, trackpad vs. mouse wheel), so
      // only the sign is forwarded rather than the raw magnitude.
      event.preventDefault();
      window.Module._engine_zoom_camera(Math.sign(event.deltaY));
    },
    { passive: false },
  );
}
