/**
 * Interactive orbit camera (issue #34, REQ-R06) -- forwards raw drag
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
 * Camera::rotate() usage: pointerdown on the canvas starts a drag,
 * pointermove/pointerup are listened for on `window` (not just the
 * canvas) so a drag already in progress isn't dropped if the pointer
 * leaves the canvas bounds or is released outside it.
 *
 * Issue #79: uses Pointer Events (not mouse events) specifically so this
 * works on touch -- a real-device mobile test found orbit simply didn't
 * respond to a finger drag at all, since `mousedown`/`mousemove` never
 * fire for touch input. Pointer Events unify mouse/touch/pen into one
 * model (`pointerType` distinguishes them when it matters), and browsers
 * still dispatch the matching pointer events for real/simulated mouse
 * input too, so this is a drop-in replacement for what was here before --
 * confirmed by this file's own existing mouse-driven e2e coverage (issue
 * #34) still passing unchanged. `touch-action: none` on #canvas
 * (style.css) is required alongside this: without it, a touch drag still
 * triggers the browser's own native scroll/pan gesture on the canvas
 * before JS ever sees pointermove, `preventDefault()` here or not.
 * Only the first pointer of a multi-touch gesture is tracked (a second
 * finger touching mid-drag is ignored, not treated as a new drag) --
 * pinch-to-zoom is not implemented; mobile has no zoom gesture yet.
 *
 * Issue #69: this same start/end lifecycle also drives
 * qualityControls.ts's interaction-adaptive quality tier -- notified
 * here rather than duplicating drag-state tracking in that module.
 */

import { notifyInteractionEnd, notifyInteractionStart } from "./qualityControls";

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
      window.Module._engine_zoom_camera(Math.sign(event.deltaY));
    },
    { passive: false },
  );
}
