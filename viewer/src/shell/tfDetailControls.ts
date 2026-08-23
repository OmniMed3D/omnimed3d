/**
 * TF detail controls (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
 * §5.3) -- extinction/density-scale/threshold sliders, a gradient-opacity
 * ("edge emphasis") slider, a Directional Occlusion Shading toggle, a mask
 * overlay opacity slider, and a mask overlay show/hide toggle. All call
 * their `engine_set_*` WASM exports
 * directly and synchronously on every input event (no queueing needed --
 * see cameraControls.ts's comment on why). Defaults here must match
 * WebGPUDevice's own member defaults (extinction_=8.0, densityScale_=1.0,
 * threshold_=0.0, gradientOpacityStrength_=0.0, occlusionEnabled_=false,
 * maskOverlayAlpha_=0.6) -- there is no readback export, so both sides
 * just agree on the same defaults independently, the same way
 * windowLevelControls.ts's DEFAULT_PRESET_ID already does.
 *
 * The occlusion checkbox is the one exception to "calls its engine_set_*
 * export directly": see its own comment below for why it's routed
 * through qualityControls.ts instead (issue #69, interaction-adaptive
 * quality).
 */

import { bindRangeInput } from "./windowLevelControls.js";
import { notifyOcclusionSelection } from "./qualityControls.js";

const DEFAULT_EXTINCTION = 8;
const DEFAULT_DENSITY_SCALE = 1;
const DEFAULT_THRESHOLD = 0;
const DEFAULT_GRADIENT_OPACITY = 0;
const DEFAULT_MASK_OPACITY = 0.6;

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
  bindRangeWithNumericEntry("mask-opacity", "mask-opacity-value", DEFAULT_MASK_OPACITY, (value) => {
    window.Module._engine_set_mask_opacity(value);
  });

  // Show/hide the mask overlay entirely, independent of its opacity slider
  // above -- purely a display toggle on the engine's already-populated
  // mask texture (rhi::Device::setMaskOverlayEnabled's header comment), so
  // switching it back on redisplays already-received mask slices instantly
  // with no re-fetch or re-inference.
  const maskEnabledCheckbox = document.getElementById("mask-overlay-enabled") as HTMLInputElement | null;
  if (!maskEnabledCheckbox) {
    console.error("tfDetailControls: #mask-overlay-enabled not found in the DOM");
  } else {
    maskEnabledCheckbox.addEventListener("change", () => {
      window.Module._engine_set_mask_overlay_enabled(maskEnabledCheckbox.checked ? 1 : 0);
    });
  }

  const occlusionCheckbox = document.getElementById("occlusion-enabled") as HTMLInputElement | null;
  if (!occlusionCheckbox) {
    console.error("tfDetailControls: #occlusion-enabled not found in the DOM");
    return;
  }
  occlusionCheckbox.addEventListener("change", () => {
    // Routed through qualityControls.ts (issue #69) rather than calling
    // engine_set_occlusion_enabled directly -- occlusion does its own
    // extra per-step sampling (one of the pricier toggles to leave on
    // during a camera drag), so its selection needs to go through the
    // same interaction-adaptive gate the quality tier and shading
    // toggle already use.
    notifyOcclusionSelection(occlusionCheckbox.checked);
  });
}
