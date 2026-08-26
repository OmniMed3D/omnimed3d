/**
 * View-mode toggle + axial slice slider (issue #37, PRD §9 slice-panning
 * gap) -- a 3D Orbit / 2D Slice button pair calling the engine's
 * `engine_set_view_mode` WASM export, plus a range slider driving
 * `engine_set_axial_slice_index`, both directly and synchronously on
 * every event (no queueing needed -- see cameraControls.ts's comment on
 * why). Kept separate from cameraControls.ts: a mode toggle that governs
 * *whether* the orbit camera even applies is a different concern than
 * the orbit camera itself.
 *
 * The slider's `max`/default value can't be known until a volume is
 * loaded (its depth is data-driven, unlike window/level's fixed clinical
 * HU defaults) -- `notifyVolumeLoaded()` is called from main.ts once the
 * loaded volume's depth is known, mirroring the engine's own
 * depth/2-default-on-load behavior (WebGPUDevice::loadVolume).
 *
 * User request, 2026-08-27: mouse wheel over the canvas scrubs the slice
 * slider while in 2D Slice mode, instead of doing nothing -- the engine's
 * own `zoomCamera()` already no-ops outside Orbit3D (`viewMode_ !=
 * kViewModeOrbit3D` guard, WebGPUDevice.cpp), so a wheel event previously
 * just vanished in 2D Slice mode. `getViewMode()`/`stepAxialSlice()` are
 * exported so cameraControls.ts's wheel handler (which owns the actual
 * `canvas.addEventListener("wheel", ...)`) can branch on the current mode
 * without this module needing to know anything about camera/zoom, or
 * that file needing its own view-mode tracking duplicated.
 */

import { bindRangeInput } from "./windowLevelControls.js";

export const VIEW_MODE_ORBIT_3D = 0;
export const VIEW_MODE_AXIAL_SLICE_2D = 1;

let currentViewMode = VIEW_MODE_ORBIT_3D;

export function getViewMode(): number {
  return currentViewMode;
}

// Clamps to the slider's own [min, max] (set per-volume by
// notifyVolumeLoaded() below) rather than letting the engine's own
// setAxialSliceIndex() clamp silently -- the slider/label would otherwise
// go stale at the boundary (same class of desync bug windowLevelControls.ts's
// preset sync already exists to avoid).
export function stepAxialSlice(delta: number): void {
  const slider = document.getElementById("axial-slice-index") as HTMLInputElement | null;
  const label = document.getElementById("axial-slice-index-value");
  if (!slider || !label) {
    console.error("viewControls: #axial-slice-index or #axial-slice-index-value not found in the DOM");
    return;
  }
  const min = Number(slider.min);
  const max = Number(slider.max);
  const next = Math.min(Math.max(Number(slider.value) + delta, min), max);
  slider.value = String(next);
  label.textContent = String(next);
  window.Module._engine_set_axial_slice_index(next);
}

export function setupViewControls(): void {
  const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-view-mode]");
  const sliceRow = document.getElementById("axial-slice-row");
  if (modeButtons.length === 0 || !sliceRow) {
    console.error("viewControls: [data-view-mode] buttons or #axial-slice-row not found in the DOM");
    return;
  }

  function setActiveMode(mode: number): void {
    currentViewMode = mode;
    modeButtons.forEach((button) => {
      button.classList.toggle("active", Number(button.dataset["viewMode"]) === mode);
    });
    sliceRow!.hidden = mode !== VIEW_MODE_AXIAL_SLICE_2D;
  }

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = Number(button.dataset["viewMode"]);
      setActiveMode(mode);
      window.Module._engine_set_view_mode(mode);
    });
  });
  setActiveMode(VIEW_MODE_ORBIT_3D);

  bindRangeInput("axial-slice-index", "axial-slice-index-value", 0, (value) => {
    window.Module._engine_set_axial_slice_index(value);
  });
}

export function notifyVolumeLoaded(depth: number): void {
  const slider = document.getElementById("axial-slice-index") as HTMLInputElement | null;
  const label = document.getElementById("axial-slice-index-value");
  if (!slider || !label) {
    console.error("viewControls: #axial-slice-index or #axial-slice-index-value not found in the DOM");
    return;
  }

  slider.max = String(Math.max(depth - 1, 0));
  const defaultIndex = Math.floor(depth / 2);
  slider.value = String(defaultIndex);
  label.textContent = String(defaultIndex);
}
