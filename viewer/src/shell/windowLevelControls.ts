/**
 * Clinical window/level UI (REQ-R06) -- two range sliders (center/width)
 * plus a baseline preset `<select>`, calling the engine's
 * `engine_set_window_level`/`engine_set_colormap_preset` WASM exports
 * directly and synchronously on every input event (no queueing needed --
 * see cameraControls.ts's comment on why). Preset `<option>` order/values
 * must match `kColormapPresets` in
 * engine/src/rhi/backends/webgpu/src/WebGPUDevice.cpp exactly (0=Lung,
 * 1=Bone, 2=Soft Tissue (default), 3=Brain, 4=Mediastinum, 5=Abdomen/Liver,
 * 6=Stroke, 7=Subdural). Custom (`CUSTOM_PRESET_ID`, 8) is a user-defined
 * colormap layered on top -- see customColormapControls.ts.
 *
 * A `<select>`, not a button grid: the fixed presets plus Custom don't
 * fit comfortably as a row of buttons. Fixed presets carry no per-preset
 * color tint (WebGPUDevice.cpp's ColormapPreset), matching a real
 * clinical reading screen.
 *
 * Sliders initialize to the Soft Tissue preset's values (40/400) to match
 * `WebGPUDevice`'s own default-on-load preset -- there is no read-back
 * export, so both sides agree on the same default independently.
 *
 * A preset click also syncs tfDetailControls.ts's #threshold slider
 * (PRESET_THRESHOLDS below), the same way it syncs
 * #window-center/#window-width -- setColormapPreset() applies a per-preset
 * default Threshold natively (WebGPUDevice.cpp's ColormapPreset::threshold)
 * so Bone shows the skeleton rather than the skin/fat surface in 3D
 * Orbit; without the sync the slider would silently disagree with engine
 * state.
 *
 * The loaded series' own VOI LUT window (see setFileWindowLevel below) is
 * exposed as a dynamic "From File" preset (`FROM_FILE_PRESET_ID`), not
 * auto-applied as an override: the value is *stored* durably (survives
 * switching presets or manual drags) and only *applied* when picked or
 * auto-selected. A per-slice DICOM window is often wrong as the first 3D
 * Orbit screen anyway (it was tuned for the 2D slice view).
 * setFileWindowLevel auto-selects "From File" only when the file's
 * Modality names something other than CT (e.g. MR) -- "has a file
 * window/level" alone is a bad proxy for non-HU data, since real CT
 * commonly carries one too. Unknown/absent Modality stays on Soft Tissue.
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

// Numeric direct-entry -- drag-only precision on a 1-4000-wide range is a
// real gap for dialing in an exact HU window. #window-center-value /
// #window-width-value are real <input type=number> elements, not
// read-only <span>s -- kept as a separate helper from bindRangeInput
// (still used as-is by viewControls.ts's slice slider, a read-only-label
// case that doesn't need this) rather than changing that shared
// function's contract for every caller.
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
// Tissue, 3=Brain, 4=Mediastinum, 5=Abdomen/Liver, 6=Stroke, 7=Subdural).
// Kept in sync here (rather than read back from the engine, which has no
// readback export) so a preset click can update the slider UI/labels to
// match, not just the engine's own state -- without this, the sliders
// silently went stale after a preset click and the next manual drag would
// overwrite the preset with the pre-click values.
const PRESET_WINDOW_LEVELS: Record<number, { center: number; width: number }> = {
  0: { center: -600, width: 1500 }, // Lung
  1: { center: 300, width: 1500 }, // Bone
  2: { center: 40, width: 400 }, // Soft Tissue (default)
  3: { center: 40, width: 80 }, // Brain
  4: { center: 50, width: 350 }, // Mediastinum
  5: { center: 50, width: 400 }, // Abdomen/Liver
  6: { center: 32, width: 8 }, // Stroke
  7: { center: 70, width: 200 }, // Subdural
};

// Custom isn't one of kColormapPresets' 0-7 indices -- it's an <option>
// in #colormap-preset-select handled specially below (its color
// application is owned by customColormapControls.ts, which also imports
// this constant to mark itself active the same way).
export const CUSTOM_PRESET_ID = 8;

// "From File" -- an extra <option>, also not one of kColormapPresets'
// fixed indices. Its center/width value is per-volume (set by
// setFileWindowLevel, not a compile-time constant), so it can't live in
// PRESET_WINDOW_LEVELS -- handled specially in the change handler below,
// same pattern as Custom.
export const FROM_FILE_PRESET_ID = 9;

// Every fixed CT preset except Lung/Bone leaves threshold at 0 because
// real CT air (~-1000 HU) already clamps to n=0, far below any of those
// windows' floors -- no explicit cutoff is needed. That margin doesn't
// exist for non-HU data (e.g. MR): its background/air is a small
// positive value near the noise floor, which lands mid-range under a
// plausible window rather than clamping to 0, so in 3D Orbit background
// renders with visible opacity. "From File"'s window comes from the
// series' own DICOM VOI LUT, which has no per-file threshold hint, so
// this is a fixed approximation: 0.15 sits above where a typical
// file-provided window's floor lands relative to a near-zero background
// without cutting into real tissue signal.
const FROM_FILE_THRESHOLD = 0.15;

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
  4: 0, // Mediastinum
  5: 0, // Abdomen/Liver
  6: 0, // Stroke
  7: 0, // Subdural
  // "From File" -- see FROM_FILE_THRESHOLD's own comment above for why
  // this one isn't 0 like most of the fixed CT presets above.
  [FROM_FILE_PRESET_ID]: FROM_FILE_THRESHOLD,
};

// The engine's own default-on-load preset (kDefaultColormapPreset in
// WebGPUDevice.cpp) -- Soft Tissue. Marked active on setup so the UI
// agrees with engine state from the first frame, not just after a click.
const DEFAULT_PRESET_ID = 2;

// Presets get the same selected-state feedback as the view-mode toggle.
// Manually dragging a slider afterward clears the active state -- the
// displayed values no longer necessarily match any preset once the user
// has diverged from it, so claiming one is still "selected" would
// misrepresent state. Exported (not a setupWindowLevelControls()-local
// closure) so customColormapControls.ts's Custom preset (CUSTOM_PRESET_ID)
// can drive the same active-state feedback when a custom color is
// picked, without duplicating this logic.
let activePresetId: number | null = DEFAULT_PRESET_ID;

// The preset picker is a native <select>. "Active" state is just the
// select's own displayed value; a null presetId (manually dragged
// Center/Width, matching a preset by coincidence or not) shows the
// blank/disabled placeholder <option value=""> instead of any real
// preset.
export function setActivePreset(presetId: number | null): void {
  activePresetId = presetId;
  const select = document.getElementById("colormap-preset-select") as HTMLSelectElement | null;
  if (select) {
    select.value = presetId === null ? "" : String(presetId);
  }
}

// "Reset TF Detail" (tfDetailControls.ts) puts Threshold back at the
// *active preset's own* default (e.g. Bone's 0.4), not the plain
// hardcoded 0 -- otherwise resetting TF Detail while Bone is selected
// would undo what setColormapPreset() set up. Returns undefined when no
// preset is currently active (manually dragged Center/Width, or Custom,
// which isn't in PRESET_THRESHOLDS) -- tfDetailControls.ts falls back to
// its own hardcoded default then.
export function getActiveThresholdDefault(): number | undefined {
  return activePresetId === null ? undefined : PRESET_THRESHOLDS[activePresetId];
}

// Updates the center/width sliders + labels and calls the engine --
// shared by the preset-select change handler and setFileWindowLevel's
// caller (the "From File" branch) so both apply a window/level value the
// exact same way. Does NOT touch setActivePreset -- callers decide what
// "active" means for their own case (a fixed preset id, FROM_FILE_PRESET_ID,
// or null for a manual drag).
function applyWindowLevel(center: number, width: number): void {
  const centerInput = document.getElementById("window-center") as HTMLInputElement | null;
  const centerLabel = document.getElementById("window-center-value") as HTMLInputElement | null;
  const widthInput = document.getElementById("window-width") as HTMLInputElement | null;
  const widthLabel = document.getElementById("window-width-value") as HTMLInputElement | null;

  if (centerInput && centerLabel) {
    centerInput.value = String(center);
    centerLabel.value = String(center);
  }
  if (widthInput && widthLabel) {
    widthInput.value = String(width);
    widthLabel.value = String(width);
  }

  window.Module._engine_set_window_level(center, width);
}

// The current volume's own VOI LUT window, if any -- set by
// setFileWindowLevel below, read by the "From File" preset branch. Stored
// independently of activePresetId/the sliders' own live values so it
// survives the user picking a different preset or dragging a slider (see
// this module's header comment for why that durability is the whole
// point of this feature).
let currentFileWindowLevel: { center: number; width: number } | null = null;

// Shared by the preset-select change handler's "From File" branch and
// setFileWindowLevel's own auto-select (see this module's header
// comment) -- both apply the file's window/level, its threshold, and
// mark the preset active in the same way.
function applyFromFilePreset(center: number, width: number): void {
  applyWindowLevel(center, width);
  const thresholdInput = document.getElementById("threshold") as HTMLInputElement | null;
  const thresholdLabel = document.getElementById("threshold-value") as HTMLInputElement | null;
  if (thresholdInput && thresholdLabel) {
    thresholdInput.value = String(FROM_FILE_THRESHOLD);
    thresholdLabel.value = String(FROM_FILE_THRESHOLD);
  }
  window.Module._engine_set_threshold(FROM_FILE_THRESHOLD);
  setActivePreset(FROM_FILE_PRESET_ID);
}

// Called by main.ts on every volume load. For non-HU data (e.g. MR),
// every fixed CT-calibrated preset is meaningless. `center`/`width` come
// from `VolumeReadyMessage.windowCenter`/`windowWidth` (the series' own
// DICOM VOI LUT window, PS3.3 C.11.2) -- `undefined` when the loaded
// series carries none, which disables the "From File" option and clears
// any previous volume's stale stored value.
//
// Auto-applies as the starting preset only when `modality` names
// something other than CT. "Does this file carry a VOI LUT window" alone
// is a bad signal for "is this non-HU data", since real CT series
// commonly carry one too. Modality (DICOM PS3.3 C.7.3.1.1.1) is the
// signal; unknown/absent modality
// (empty string) falls back to the pre-this-feature default (stays on
// Soft Tissue, same as the plain CT case) rather than guessing either way.
// "From File" stays selectable from the dropdown regardless -- this only
// decides what the *first-seen* view starts on.
export function setFileWindowLevel(center: number | undefined, width: number | undefined, modality?: string): void {
  const option = document.getElementById("from-file-preset-option") as HTMLOptionElement | null;
  if (center === undefined || width === undefined) {
    currentFileWindowLevel = null;
    if (option) {
      option.disabled = true;
      option.title =
        "The loaded series' own recommended display window (DICOM VOI LUT) -- unavailable until a series carrying one is loaded";
    }
    // If "From File" was active for a previous volume that this new one
    // has no equivalent for, its value is now stale/meaningless -- fall
    // back to the blank manual-drag state rather than silently keep
    // showing "From File" selected next to numbers that no longer mean
    // anything.
    if (activePresetId === FROM_FILE_PRESET_ID) {
      setActivePreset(null);
    }
    return;
  }
  currentFileWindowLevel = { center, width };
  if (option) {
    option.disabled = false;
    option.title = `Center ${center} / Width ${width} -- this series' own DICOM VOI LUT window`;
  }
  const normalizedModality = modality?.trim().toUpperCase();
  const isKnownNonCT = normalizedModality !== undefined && normalizedModality !== "" && normalizedModality !== "CT";
  if (isKnownNonCT) {
    applyFromFilePreset(center, width);
  }
}

export function setupWindowLevelControls(): void {
  let center = DEFAULT_WINDOW_CENTER;
  let width = DEFAULT_WINDOW_WIDTH;

  const applyCurrentWindowLevel = () => window.Module._engine_set_window_level(center, width);

  const centerInput = document.getElementById("window-center") as HTMLInputElement | null;
  const centerLabel = document.getElementById("window-center-value") as HTMLInputElement | null;
  const widthInput = document.getElementById("window-width") as HTMLInputElement | null;
  const widthLabel = document.getElementById("window-width-value") as HTMLInputElement | null;
  const presetSelect = document.getElementById("colormap-preset-select") as HTMLSelectElement | null;

  bindRangeWithNumericEntry("window-center", "window-center-value", DEFAULT_WINDOW_CENTER, (value) => {
    center = value;
    setActivePreset(null);
    applyCurrentWindowLevel();
  });
  bindRangeWithNumericEntry("window-width", "window-width-value", DEFAULT_WINDOW_WIDTH, (value) => {
    width = value;
    setActivePreset(null);
    applyCurrentWindowLevel();
  });

  if (!presetSelect) {
    console.error("windowLevelControls: #colormap-preset-select not found in the DOM");
    return;
  }

  presetSelect.addEventListener("change", () => {
    const presetId = Number(presetSelect.value);
    // Custom isn't one of kColormapPresets' 0-7 indices -- its color
    // application is owned by customColormapControls.ts (the
    // color pickers call engine_set_custom_lut_colors directly), and it
    // doesn't imply a specific window/level. This handler only needs to
    // give it the same active-state feedback the other presets get.
    if (presetId === CUSTOM_PRESET_ID) {
      setActivePreset(presetId);
      return;
    }
    // "From File" -- unlike every fixed preset, there's no
    // engine_set_colormap_preset equivalent that natively knows
    // this per-volume value, so this branch calls engine_set_window_level
    // itself via the shared applyWindowLevel helper (also used nowhere
    // else in this file -- the fixed-preset branch below intentionally
    // relies on engine_set_colormap_preset having already set window/level
    // natively, only mirroring it into the sliders, so it doesn't need a
    // second explicit engine_set_window_level call). Same reasoning for
    // threshold, applied explicitly here instead of arriving for free --
    // see FROM_FILE_THRESHOLD's own comment for why 3D Orbit needs one at
    // all for non-HU data.
    if (presetId === FROM_FILE_PRESET_ID) {
      if (!currentFileWindowLevel) {
        console.error('windowLevelControls: "From File" selected but no file window/level is stored, ignoring');
        return;
      }
      center = currentFileWindowLevel.center;
      width = currentFileWindowLevel.width;
      applyFromFilePreset(center, width);
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

  setActivePreset(DEFAULT_PRESET_ID);
}
