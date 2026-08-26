/**
 * Clinical window/level UI (issue #34, REQ-R06) -- two range sliders
 * (center/width) plus baseline preset buttons, calling the engine's
 * `engine_set_window_level`/`engine_set_colormap_preset` WASM exports
 * directly and synchronously on every input event (no queueing needed --
 * see cameraControls.ts's comment on why). Preset button order/values
 * must match `kColormapPresets` in
 * engine/src/rhi/backends/webgpu/src/WebGPUDevice.cpp exactly (0=Lung,
 * 1=Bone, 2=Soft Tissue, 3=Brain, 4=Grayscale). Custom (id 5) is a 6th,
 * user-defined colormap layered on top -- see customColormapControls.ts.
 *
 * Sliders initialize to the Grayscale preset's values (40/400) to
 * match `WebGPUDevice`'s own default-on-load preset -- no read-back
 * export from the engine exists (or is needed) to sync this; both sides
 * just agree on the same default independently, the same way
 * `kDefaultColormapPreset` is a plain constant on the C++ side.
 *
 * User request, 2026-08-27: a preset click also syncs tfDetailControls.ts's
 * #threshold slider (PRESET_THRESHOLDS below), the same way it already
 * syncs #window-center/#window-width -- setColormapPreset() now applies a
 * per-preset default Threshold natively (WebGPUDevice.cpp's
 * ColormapPreset::threshold) so Bone actually shows the skeleton rather
 * than the skin/fat surface in 3D Orbit; without this sync the slider
 * would silently disagree with engine state after a preset click, same
 * class of bug PRESET_WINDOW_LEVELS already exists to avoid.
 */

const DEFAULT_WINDOW_CENTER = 40;
const DEFAULT_WINDOW_WIDTH = 400;

export function bindRangeInput(
  inputId: string,
  valueId: string,
  initial: number,
  onInput: (value: number) => void,
): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const valueLabel = document.getElementById(valueId);
  if (!input || !valueLabel) {
    console.error(`windowLevelControls: #${inputId} or #${valueId} not found in the DOM`);
    return;
  }

  input.value = String(initial);
  valueLabel.textContent = String(initial);

  input.addEventListener("input", () => {
    const value = Number(input.value);
    valueLabel.textContent = String(value);
    onInput(value);
  });
}

// Follow-up: numeric direct-entry (critique heuristic #7, Flexibility
// and Efficiency -- drag-only precision on a 1-4000-wide range was a
// real gap for anyone dialing in an exact HU window). #window-center-value
// / #window-width-value are real <input type=number> elements now, not
// read-only <span>s -- kept as a separate helper from bindRangeInput
// (still used as-is by viewControls.ts's slice slider, a read-only-label
// case that doesn't need this) rather than changing that shared function's
// contract for every caller.
function bindRangeWithNumericEntry(
  rangeId: string,
  valueId: string,
  initial: number,
  onInput: (value: number) => void,
): void {
  const rangeInput = document.getElementById(rangeId) as HTMLInputElement | null;
  const numberInput = document.getElementById(valueId) as HTMLInputElement | null;
  if (!rangeInput || !numberInput) {
    console.error(`windowLevelControls: #${rangeId} or #${valueId} not found in the DOM`);
    return;
  }

  rangeInput.value = String(initial);
  numberInput.value = String(initial);

  rangeInput.addEventListener("input", () => {
    const value = Number(rangeInput.value);
    numberInput.value = String(value);
    onInput(value);
  });

  // "change" (fires on blur/Enter), not "input" -- applying on every
  // keystroke would fire mid-typing intermediate values (e.g. "-", "-5",
  // "-50" while typing "-500").
  numberInput.addEventListener("change", () => {
    const min = Number(rangeInput.min);
    const max = Number(rangeInput.max);
    const clamped = Math.min(Math.max(Number(numberInput.value), min), max);
    numberInput.value = String(clamped);
    rangeInput.value = String(clamped);
    onInput(clamped);
  });
}

// Preset center/width values, indexed by presetId -- must match
// WebGPUDevice.cpp's kColormapPresets exactly (0=Lung, 1=Bone, 2=Soft
// Tissue, 3=Brain, 4=Grayscale). Kept in sync here (rather than read back
// from the engine, which has no readback export) so a preset click can
// update the slider UI/labels to match, not just the engine's own state --
// without this, the sliders silently went stale after a preset click and
// the next manual drag would overwrite the preset with the pre-click values.
const PRESET_WINDOW_LEVELS: Record<number, { center: number; width: number }> = {
  0: { center: -600, width: 1500 }, // Lung
  1: { center: 300, width: 1500 }, // Bone
  2: { center: 40, width: 400 }, // Soft Tissue
  3: { center: 40, width: 80 }, // Brain
  4: { center: 40, width: 400 }, // Grayscale
};

// Mirrors kColormapPresets[presetId].threshold (WebGPUDevice.cpp) -- kept
// in sync here for the same reason PRESET_WINDOW_LEVELS is: setColormapPreset()
// applies this natively (no readback export), but the #threshold slider
// (tfDetailControls.ts) would otherwise go stale after a preset click, the
// same desync bug PRESET_WINDOW_LEVELS's own header comment already
// describes for center/width. Only Bone gets a nonzero default -- see
// ColormapPreset's own comment in WebGPUDevice.cpp for why Lung/Brain are
// deliberately left at 0 rather than given a value that looks like a fix
// but isn't one.
const PRESET_THRESHOLDS: Record<number, number> = {
  0: 0.25, // Lung -- see ColormapPreset's own comment (WebGPUDevice.cpp) for why
  1: 0.4, // Bone
  2: 0, // Soft Tissue
  3: 0, // Brain
  4: 0, // Grayscale
};

// The engine's own default-on-load preset (kDefaultColormapPreset in
// WebGPUDevice.cpp) -- Grayscale. Marked active on setup so the UI
// agrees with engine state from the first frame, not just after a click.
const DEFAULT_PRESET_ID = 4;

// Visual polish pass: presets get the same selected-state feedback the
// view-mode toggle already had (critique heuristic #4, Consistency).
// Manually dragging a slider afterward clears the active state -- the
// displayed values no longer necessarily match any preset once the user
// has diverged from it, so claiming one is still "selected" would
// misrepresent state (the same class of bug the preset/slider desync fix
// closed). Exported (not a setupWindowLevelControls()-local closure) so
// customColormapControls.ts's §5.3 Custom preset (id 4, also carrying
// `data-colormap-preset` so it's included in the same querySelectorAll
// here) can drive the same active-state feedback when a custom color is
// picked, without duplicating this query/toggle logic.
let activePresetId: number | null = DEFAULT_PRESET_ID;

export function setActivePreset(presetId: number | null): void {
  activePresetId = presetId;
  document.querySelectorAll<HTMLButtonElement>("[data-colormap-preset]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset["colormapPreset"]) === presetId);
  });
}

// User request, 2026-08-27: "Reset TF Detail" (tfDetailControls.ts) should
// put Threshold back at the *active preset's own* default (e.g. Bone's
// 0.4), not always the plain hardcoded 0 -- otherwise resetting TF Detail
// while Bone is selected would undo exactly the preset behavior
// setColormapPreset() just set up. Returns undefined when no preset is
// currently active (manually dragged Center/Width, or Custom, id 5, which
// isn't in PRESET_THRESHOLDS) -- tfDetailControls.ts falls back to its own
// hardcoded default in that case.
export function getActiveThresholdDefault(): number | undefined {
  return activePresetId === null ? undefined : PRESET_THRESHOLDS[activePresetId];
}

export function setupWindowLevelControls(): void {
  let center = DEFAULT_WINDOW_CENTER;
  let width = DEFAULT_WINDOW_WIDTH;

  const applyWindowLevel = () => window.Module._engine_set_window_level(center, width);

  const centerInput = document.getElementById("window-center") as HTMLInputElement | null;
  const centerLabel = document.getElementById("window-center-value") as HTMLInputElement | null;
  const widthInput = document.getElementById("window-width") as HTMLInputElement | null;
  const widthLabel = document.getElementById("window-width-value") as HTMLInputElement | null;
  const presetButtons = document.querySelectorAll<HTMLButtonElement>("[data-colormap-preset]");

  bindRangeWithNumericEntry("window-center", "window-center-value", DEFAULT_WINDOW_CENTER, (value) => {
    center = value;
    setActivePreset(null);
    applyWindowLevel();
  });
  bindRangeWithNumericEntry("window-width", "window-width-value", DEFAULT_WINDOW_WIDTH, (value) => {
    width = value;
    setActivePreset(null);
    applyWindowLevel();
  });

  presetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const presetId = Number(button.dataset["colormapPreset"]);
      // Custom (§5.3, id 5) isn't one of kColormapPresets' 0-4 indices --
      // its color application is owned by customColormapControls.ts (the
      // color pickers call engine_set_custom_lut_colors directly), and it
      // doesn't imply a specific window/level. This handler only needs to
      // give it the same active-state feedback the other 5 presets get.
      if (presetId === 5) {
        setActivePreset(presetId);
        return;
      }
      window.Module._engine_set_colormap_preset(presetId);

      const preset = PRESET_WINDOW_LEVELS[presetId];
      if (!preset) {
        return;
      }
      center = preset.center;
      width = preset.width;
      if (centerInput && centerLabel) {
        centerInput.value = String(center);
        centerLabel.value = String(center);
      }
      if (widthInput && widthLabel) {
        widthInput.value = String(width);
        widthLabel.value = String(width);
      }

      const presetThreshold = PRESET_THRESHOLDS[presetId];
      const thresholdInput = document.getElementById("threshold") as HTMLInputElement | null;
      const thresholdLabel = document.getElementById("threshold-value") as HTMLInputElement | null;
      if (presetThreshold !== undefined && thresholdInput && thresholdLabel) {
        thresholdInput.value = String(presetThreshold);
        thresholdLabel.value = String(presetThreshold);
      }

      setActivePreset(presetId);
    });
  });

  setActivePreset(DEFAULT_PRESET_ID);
}
