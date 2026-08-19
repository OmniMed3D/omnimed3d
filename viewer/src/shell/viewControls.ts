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
 */

import { bindRangeInput } from "./windowLevelControls.js";

const VIEW_MODE_ORBIT_3D = 0;
const VIEW_MODE_AXIAL_SLICE_2D = 1;

export function setupViewControls(): void {
  const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-view-mode]");
  const sliceRow = document.getElementById("axial-slice-row");
  if (modeButtons.length === 0 || !sliceRow) {
    console.error("viewControls: [data-view-mode] buttons or #axial-slice-row not found in the DOM");
    return;
  }

  function setActiveMode(mode: number): void {
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
