/**
 * Custom colormap controls (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
 * §5.3) -- two `<input type="color">` pickers driving
 * `engine_set_custom_lut_colors` directly and synchronously on every
 * `input` event (no queueing needed -- see cameraControls.ts's comment on
 * why). Unlike the 5 fixed presets, Custom doesn't change window/level and
 * has no `engine_set_colormap_preset` counterpart (that export only
 * accepts kColormapPresets' 0-4 range) -- windowLevelControls.ts's preset
 * click handler special-cases id 5 to just call setActivePreset() for the
 * visual state, while this file owns actually applying the colors.
 */

import { setActivePreset } from "./windowLevelControls.js";

function hexToUnitFloat(hex: string, start: number): number {
  return parseInt(hex.slice(start, start + 2), 16) / 255;
}

export function setupCustomColormapControls(): void {
  const lowInput = document.getElementById("custom-low-color") as HTMLInputElement | null;
  const highInput = document.getElementById("custom-high-color") as HTMLInputElement | null;
  if (!lowInput || !highInput) {
    console.error("customColormapControls: #custom-low-color or #custom-high-color not found in the DOM");
    return;
  }

  function applyCustomColors(): void {
    window.Module._engine_set_custom_lut_colors(
      hexToUnitFloat(lowInput!.value, 1),
      hexToUnitFloat(lowInput!.value, 3),
      hexToUnitFloat(lowInput!.value, 5),
      hexToUnitFloat(highInput!.value, 1),
      hexToUnitFloat(highInput!.value, 3),
      hexToUnitFloat(highInput!.value, 5),
    );
    setActivePreset(5);
  }

  lowInput.addEventListener("input", applyCustomColors);
  highInput.addEventListener("input", applyCustomColors);
}
