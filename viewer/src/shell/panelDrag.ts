/**
 * Draggable panel positioning (visual polish follow-up; generalized for
 * the stats overlay's own drag handle -- see statsOverlay.ts). Runtime-only,
 * deliberately not persisted: reset to each panel's default CSS position on
 * reload. For #control-panel specifically, #panel-drag-grip (the dot grip)
 * and #panel-collapse-toggle are siblings inside #panel-drag-handle, not
 * nested, so neither needs stopPropagation to avoid triggering the
 * other. The rest of the panel (buttons/sliders/inputs) stays
 * interactive as normal since they're outside the handle entirely.
 *
 * Drag lifecycle mirrors cameraControls.ts's mousedown-on-target /
 * mousemove-on-window / mouseup-on-window pattern, so a drag already in
 * progress isn't dropped if the pointer leaves the (small) grip.
 * Touch events mirrored for mobile (REQ-R07 Mobile Chrome is P0).
 */

export function setupPanelDrag(panelId: string, handleId: string): void {
  const panel = document.getElementById(panelId);
  const handle = document.getElementById(handleId);
  if (!panel || !handle) {
    console.error(`panelDrag: #${panelId} or #${handleId} not found in the DOM`);
    return;
  }

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let panelStartLeft = 0;
  let panelStartTop = 0;

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  function beginDrag(clientX: number, clientY: number): void {
    dragging = true;
    startX = clientX;
    startY = clientY;
    const rect = panel!.getBoundingClientRect();
    panelStartLeft = rect.left;
    panelStartTop = rect.top;
    // First drag switches from whichever CSS default corner (#control-panel:
    // top/right, #stats-overlay: top/left) to explicit top/left in pixels,
    // so the panel can move freely instead of staying pinned to that corner.
    // getBoundingClientRect() above already reflects whichever positioning
    // drove it here, so this is safe to repeat across multiple drags in the
    // same session. right/bottom are cleared unconditionally since a caller
    // whose CSS default anchors via either (not just #control-panel's right)
    // would otherwise keep fighting the newly-set left/top.
    panel!.style.right = "auto";
    panel!.style.bottom = "auto";
    panel!.style.left = `${panelStartLeft}px`;
    panel!.style.top = `${panelStartTop}px`;
  }

  function moveDrag(clientX: number, clientY: number): void {
    if (!dragging) {
      return;
    }
    const rect = panel!.getBoundingClientRect();
    const maxLeft = Math.max(window.innerWidth - rect.width, 0);
    const maxTop = Math.max(window.innerHeight - rect.height, 0);
    const newLeft = clamp(panelStartLeft + (clientX - startX), 0, maxLeft);
    const newTop = clamp(panelStartTop + (clientY - startY), 0, maxTop);
    panel!.style.left = `${newLeft}px`;
    panel!.style.top = `${newTop}px`;
  }

  function endDrag(): void {
    dragging = false;
  }

  handle.addEventListener("mousedown", (event: MouseEvent) => {
    beginDrag(event.clientX, event.clientY);
    event.preventDefault();
  });
  window.addEventListener("mousemove", (event: MouseEvent) => {
    moveDrag(event.clientX, event.clientY);
  });
  window.addEventListener("mouseup", endDrag);

  handle.addEventListener(
    "touchstart",
    (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch) {
        beginDrag(touch.clientX, touch.clientY);
      }
      event.preventDefault();
    },
    { passive: false },
  );
  window.addEventListener(
    "touchmove",
    (event: TouchEvent) => {
      if (!dragging) {
        return;
      }
      const touch = event.touches[0];
      if (touch) {
        moveDrag(touch.clientX, touch.clientY);
      }
      // Stop page scroll while actively dragging -- only once a drag is
      // underway, so an ordinary touch-scroll starting elsewhere is
      // unaffected.
      event.preventDefault();
    },
    { passive: false },
  );
  window.addEventListener("touchend", endDrag);
}

/**
 * Collapse toggle (critique heuristic #3, User Control and Freedom --
 * "panel can't be dismissed"). Hides every .panel-section via a
 * .collapsed class on #control-panel (style.css); the drag handle
 * itself stays visible and draggable either way, so a collapsed panel
 * can still be moved out from over content it would otherwise cover.
 */
// Issue #69: `?debug=1` starts the panel already collapsed, out of the
// way of the stats overlay it's meant to pair with on a mobile screen
// too small for both at once. Defaults to false (pre-existing
// expanded-by-default behavior) so normal/product usage is unaffected.
export function setupPanelCollapse(startCollapsed = false): void {
  const panel = document.getElementById("control-panel");
  const toggle = document.getElementById("panel-collapse-toggle");
  if (!panel || !toggle) {
    console.error("panelDrag: #control-panel or #panel-collapse-toggle not found in the DOM");
    return;
  }

  toggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
  });

  if (startCollapsed) {
    panel.classList.add("collapsed");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Expand panel");
  }
}
