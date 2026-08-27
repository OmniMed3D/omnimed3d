/**
 * Interactive orbit camera (REQ-R06) -- forwards raw drag pixel deltas and
 * normalized wheel direction directly to the engine's
 * `engine_orbit_camera`/`engine_zoom_camera` WASM exports every event, no
 * batching/queueing. That's safe specifically because `WebGPUDevice`
 * never uses ASYNCIFY (see its own `AllowSpontaneous` comment,
 * engine/src/rhi/backends/webgpu/src/WebGPUDevice.cpp), so there is no
 * suspended call stack to re-enter.
 *
 * Drag lifecycle: pointerdown on the canvas starts a drag,
 * pointermove/pointerup are listened for on `window` (not just the
 * canvas) so a drag already in progress isn't dropped if the pointer
 * leaves the canvas bounds or is released outside it.
 *
 * Uses Pointer Events (not mouse events) so this works on touch --
 * `mousedown`/`mousemove` never fire for touch input. Pointer Events
 * unify mouse/touch/pen into one model (`pointerType` distinguishes them
 * when it matters), and browsers still dispatch matching pointer events
 * for mouse input, so this is a drop-in replacement for mouse-only
 * handling. `touch-action: none` on #canvas (style.css) is required
 * alongside this: without it, a touch drag triggers the browser's own
 * native scroll/pan gesture on the canvas before JS ever sees
 * pointermove, `preventDefault()` here or not. Only the first pointer of
 * a multi-touch gesture is tracked; pinch-to-zoom is not implemented.
 *
 * This same start/end lifecycle also drives qualityControls.ts's
 * interaction-adaptive quality tier -- notified here rather than
 * duplicating drag-state tracking in that module.
 *
 * The wheel handler branches on the current view mode -- Orbit3D zooms
 * the camera, Axial Slice 2D scrubs the slice slider instead (where
 * engine_zoom_camera no-ops). Mode lives in viewControls.ts, not
 * duplicated here -- see getViewMode()'s own comment.
 */

import { notifyInteractionEnd, notifyInteractionStart } from "./qualityControls";
import { getViewMode, stepSlice, VIEW_MODE_SLICE_2D, VIEW_MODE_NATIVE_SLICE_2D } from "./viewControls.js";

export function setupCameraControls(): void {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("cameraControls: #canvas not found in the DOM");
    return;
  }

  let activePointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (activePointerId !== null) {
      return; // a drag is already in progress -- ignore a second touch point
    }
    activePointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    notifyInteractionStart();
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    window.Module._engine_orbit_camera(dx, dy);
  });

  function endDrag(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) {
      return;
    }
    activePointerId = null;
    notifyInteractionEnd();
  }
  // pointercancel fires when the browser/OS interrupts the gesture (e.g.
  // a system-level swipe) -- must also clear activePointerId, or a drag
  // could get stuck "in progress" forever with no matching pointerup.
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  canvas.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      // Stop page scroll; normalize to +-1 per notch -- real wheel-event
      // deltaY magnitude is inconsistent across browsers/devices
      // (DOM_DELTA_PIXEL vs DOM_DELTA_LINE, trackpad vs. mouse wheel), so
      // only the sign is forwarded rather than the raw magnitude.
      event.preventDefault();
      const notches = Math.sign(event.deltaY);
      const viewMode = getViewMode();
      if (viewMode === VIEW_MODE_SLICE_2D || viewMode === VIEW_MODE_NATIVE_SLICE_2D) {
        stepSlice(notches);
        return;
      }
      window.Module._engine_zoom_camera(notches);
    },
    { passive: false },
  );
}
