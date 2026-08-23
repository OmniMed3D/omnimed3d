/**
 * Hover/keyboard-focus tooltips for control-panel adjustment controls
 * (user request, 2026-08-21) -- explains what each slider/toggle/preset
 * button actually does. This codebase had no tooltip infrastructure
 * before this (no `title` attribute usage, no `data-tooltip` CSS pattern
 * anywhere).
 *
 * Rendered as a single shared element appended to <body> (position:fixed),
 * NOT a CSS ::after pseudo-element on each control: #control-panel has
 * `overflow-y: auto` (added once TF Detail/Clip made it taller than the
 * viewport on shorter screens). Per the CSS Overflow spec, setting only
 * one axis to a non-`visible` value computes the OTHER axis to `auto`
 * too -- so #control-panel clips in both directions, and any descendant
 * positioned to pop outside its box (above/below/left/right) gets cut
 * off. A body-level element positioned via getBoundingClientRect() is the
 * only way to show a tooltip that isn't clipped near the panel's edges or
 * mid-scroll.
 *
 * Desktop-pointer/keyboard-focus only, deliberately -- gated on
 * `(hover: hover) and (pointer: fine)` so the whole manager is a no-op on
 * touch devices. Two reasons, not just "less code": (1) no touch fallback
 * convention exists anywhere in this codebase yet to extend (no
 * `(hover)`/`(pointer)` media query, no tap-to-reveal pattern) -- adding
 * one is a separate feature; (2) `mouseenter` synthesizes on first tap on
 * mobile Safari/Chrome for elements with no other handler, which would
 * pop a tooltip open on a slider *drag start* and never close it (no
 * `mouseleave` fires from a touch drag). Touch/screen-reader users are no
 * worse off than before this feature -- every targeted control already
 * has a visible `<label>` or `aria-label`.
 */

const TOOLTIP_TEXT: Record<string, string> = {
  "window-center": "Shifts the visible HU range up or down (window center).",
  "window-width": "Widens or narrows the visible HU range (window width).",
  "colormap-preset-0": "Lung window preset: center -600 HU, width 1500 HU.",
  "colormap-preset-1": "Bone window preset: center 300 HU, width 1500 HU.",
  "colormap-preset-2": "Soft Tissue window preset: center 40 HU, width 400 HU.",
  "colormap-preset-3": "Brain window preset: center 40 HU, width 80 HU.",
  "colormap-preset-4": "Grayscale window preset (default): center 40 HU, width 400 HU, no color tint.",
  "custom-preset-button": "Custom colormap -- set with the color pickers below; doesn't change window/level.",
  "custom-low-color": "Low end of the custom color gradient.",
  "custom-high-color": "High end of the custom color gradient.",
  "view-mode-0": "3D orbit camera view of the full volume.",
  "view-mode-1": "Single 2D axial cross-section, scrubbed by the Slice slider below.",
  "axial-slice-index": "Which Z slice the 2D Slice view shows.",
  "quality-tier-0": "Fewer ray-march steps -- faster, coarser image.",
  "quality-tier-1": "Balanced ray-march step count (default).",
  "quality-tier-2": "More ray-march steps -- slower, sharper image.",
  "shading-enabled": "Gradient-based lighting for depth and surface form.",
  "extinction": "Beer-Lambert absorption coefficient -- higher makes the volume look denser.",
  "density-scale": "Multiplies classified density before absorption -- an overall density boost or reduction.",
  "threshold": "Density below this value contributes no opacity -- cuts out background/noise.",
  "gradient-opacity": "Weights opacity by local edge strength -- emphasizes boundaries, suppresses flat regions.",
  "occlusion-enabled": "Approximate self-shadowing toward the light. Only visible when Shading is also on.",
  "mask-opacity": "Blend strength of the AI segmentation mask highlight over the volume. 0 hides it, 1 fully replaces the underlying color.",
  "clip-x-min": "Clip box: minimum X bound (world mm).",
  "clip-x-max": "Clip box: maximum X bound (world mm).",
  "clip-y-min": "Clip box: minimum Y bound (world mm).",
  "clip-y-max": "Clip box: maximum Y bound (world mm).",
  "clip-z-min": "Clip box: minimum Z bound (world mm).",
  "clip-z-max": "Clip box: maximum Z bound (world mm).",
  "clip-reset": "Resets the clip box to the full volume (no clipping).",
  "background-preset-dark": "Dark teal-black background (default).",
  "background-preset-black": "Pure black background.",
  "background-preset-gray": "Mid-gray background -- reduces eye strain for extended reading, a common radiology-viewer convention.",
  "background-preset-white": "Pure white background.",
  "stats-overlay-enabled": "Shows FPS, frame time, and GPU vendor/device info.",
  "stat-perf": "Frames per second and per-frame render time, averaged over the last 60 frames.",
  "stat-gpu-pass": "Actual GPU time spent rendering (WebGPU timestamp-query), not wall-clock frame time -- unlike Perf above, this isn't capped by the display's refresh rate, so it stays meaningful even when Perf is vsync-limited. Shows \"unsupported\" if this browser/GPU doesn't support GPU timestamp queries.",
  "stat-canvas": "Canvas backing-store resolution, in device pixels (post-devicePixelRatio scaling).",
  "stat-gpu-vendor": "GPU vendor, as reported by the browser's WebGPU adapter.",
  "stat-gpu-device": "GPU device name, as reported by the browser's WebGPU adapter -- often unavailable (n/a) since browsers restrict this for fingerprinting reasons.",
  "stat-gpu-arch": "GPU architecture family, as reported by the browser's WebGPU adapter.",
  "stat-gpu-desc": "Full GPU description string, as reported by the browser's WebGPU adapter.",
  "stats-overlay-copy": "Copies all stats above to the clipboard as plain text.",
};

const VIEWPORT_MARGIN = 8;

export function setupTooltips(): void {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    return;
  }

  const targets = document.querySelectorAll<HTMLElement>("[data-tooltip-key]");
  if (targets.length === 0) {
    return;
  }

  const tooltip = document.createElement("div");
  tooltip.id = "control-tooltip";
  tooltip.hidden = true;
  document.body.append(tooltip);

  function show(target: HTMLElement): void {
    const text = TOOLTIP_TEXT[target.dataset["tooltipKey"] ?? ""];
    if (!text) {
      return;
    }
    tooltip.textContent = text;
    tooltip.hidden = false;

    // Prefer appearing to the left of the control (the panel is a fixed-
    // width right-docked sidebar, so there's reliably room there without
    // needing to know the tooltip's own height/width ahead of time the
    // way above/below placement would). Clamped to the viewport so a
    // control near the top/bottom edge doesn't push the tooltip off-screen.
    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let left = rect.left - tooltipRect.width - 10;
    if (left < VIEWPORT_MARGIN) {
      // Not enough room to the left (e.g. a narrow window) -- fall back
      // to the right of the control instead of running off-screen.
      left = Math.min(rect.right + 10, window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN);
    }

    let top = rect.top + rect.height / 2 - tooltipRect.height / 2;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - tooltipRect.height - VIEWPORT_MARGIN));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hide(): void {
    tooltip.hidden = true;
  }

  targets.forEach((target) => {
    target.addEventListener("mouseenter", () => show(target));
    target.addEventListener("mouseleave", hide);
    target.addEventListener("focus", () => show(target));
    target.addEventListener("blur", hide);
  });
}
