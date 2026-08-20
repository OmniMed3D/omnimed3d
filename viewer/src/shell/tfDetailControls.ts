/**
 * TF detail controls (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
 * §5.3) -- extinction/density-scale/threshold sliders, a gradient-opacity
 * ("edge emphasis") slider, and a Directional Occlusion Shading toggle.
 * All call their `engine_set_*` WASM exports directly and synchronously
 * on every input event (no queueing needed -- see cameraControls.ts's
 * comment on why). Defaults here must match WebGPUDevice's own member
 * defaults (extinction_=8.0, densityScale_=1.0, threshold_=0.0,
 * gradientOpacityStrength_=0.0, occlusionEnabled_=false) -- there is no
 * readback export, so both sides just agree on the same defaults
 * independently, the same way windowLevelControls.ts's DEFAULT_PRESET_ID
 * already does.
 */

import { bindRangeInput } from "./windowLevelControls.js";

const DEFAULT_EXTINCTION = 8;
const DEFAULT_DENSITY_SCALE = 1;
const DEFAULT_THRESHOLD = 0;
const DEFAULT_GRADIENT_OPACITY = 0;

// Mirrors windowLevelControls.ts's own bindRangeWithNumericEntry (not
// exported from there -- it's file-private since only that file's two
// window/level sliders needed it before now).
function bindRangeWithNumericEntry(
  rangeId: string,
  valueId: string,
  initial: number,
  onInput: (value: number) => void,
): void {
  const rangeInput = document.getElementById(rangeId) as HTMLInputElement | null;
  const numberInput = document.getElementById(valueId) as HTMLInputElement | null;
  if (!rangeInput || !numberInput) {
    console.error(`tfDetailControls: #${rangeId} or #${valueId} not found in the DOM`);
    return;
  }

  rangeInput.value = String(initial);
  numberInput.value = String(initial);

  rangeInput.addEventListener("input", () => {
    const value = Number(rangeInput.value);
    numberInput.value = String(value);
    onInput(value);
  });

  numberInput.addEventListener("change", () => {
    const min = Number(rangeInput.min);
    const max = Number(rangeInput.max);
    const clamped = Math.min(Math.max(Number(numberInput.value), min), max);
    numberInput.value = String(clamped);
    rangeInput.value = String(clamped);
    onInput(clamped);
  });
}

export function setupTfDetailControls(): void {
  bindRangeWithNumericEntry("extinction", "extinction-value", DEFAULT_EXTINCTION, (value) => {
    window.Module._engine_set_extinction(value);
  });
  bindRangeWithNumericEntry("density-scale", "density-scale-value", DEFAULT_DENSITY_SCALE, (value) => {
    window.Module._engine_set_density_scale(value);
  });
  bindRangeWithNumericEntry("threshold", "threshold-value", DEFAULT_THRESHOLD, (value) => {
    window.Module._engine_set_threshold(value);
  });
  bindRangeInput("gradient-opacity", "gradient-opacity-value", DEFAULT_GRADIENT_OPACITY, (value) => {
    window.Module._engine_set_gradient_opacity_strength(value);
  });

  const occlusionCheckbox = document.getElementById("occlusion-enabled") as HTMLInputElement | null;
  if (!occlusionCheckbox) {
    console.error("tfDetailControls: #occlusion-enabled not found in the DOM");
    return;
  }
  occlusionCheckbox.addEventListener("change", () => {
    window.Module._engine_set_occlusion_enabled(occlusionCheckbox.checked ? 1 : 0);
  });
}
