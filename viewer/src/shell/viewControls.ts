/**
 * View-mode toggle + slice slider (issue #37, PRD §9 slice-panning gap) --
 * originally a 3D Orbit / 2D Slice (Axial-only) button pair calling the
 * engine's `engine_set_view_mode` WASM export, plus a range slider driving
 * `engine_set_axial_slice_index`, both directly and synchronously on every
 * event (no queueing needed -- see cameraControls.ts's comment on why).
 * Kept separate from cameraControls.ts: a mode toggle that governs
 * *whether* the orbit camera even applies is a different concern than the
 * orbit camera itself.
 *
 * MPR + native-slice feature (2026-08-27 user request): the single "2D
 * Slice" button is now three -- Axial/Sagittal/Coronal (`data-slice-axis`
 * on top of `data-view-mode="1"`) -- plus a fourth, independent "Native"
 * mode (`data-view-mode="2"`) showing the DICOM series' own original
 * per-file slices (see pipeline.ts's NativeVolumeReadyMessage). The slice
 * slider's valid range depends on both view mode and (for Slice2D) which
 * axis is active -- Axial scrubs depth, Sagittal scrubs width, Coronal
 * scrubs height, Native scrubs its own independently-loaded depth --
 * so `notifyVolumeLoaded`/`notifyNativeVolumeLoaded` record the loaded
 * volume(s)' dimensions here rather than just a single depth value.
 *
 * User feedback, 2026-08-27 (same-day follow-up): switching modes/axes
 * used to always reset the slice to the middle of that mode's range --
 * annoying on its own (losing your place every click), and outright wrong
 * for Native specifically: the *engine's* own `nativeSliceIndex_` doesn't
 * reset on a mode switch (only `loadNativeVolume()` resets it), but this
 * module was recomputing a fresh "middle" for the slider's *display*
 * without ever pushing it to the engine -- the slider would show a value
 * the actually-rendered image didn't match. Fixed by remembering each
 * mode/axis's own last index (`sagittalIndex`/`coronalIndex`/
 * `axialNativeIndex`) and re-applying it (clamped to the current
 * dimension, via `applySliceIndex`) on every switch, rather than always
 * recomputing a fresh middle. Axial and Native deliberately share one
 * remembered value (`axialNativeIndex`) per user request -- for the
 * common case (an already-axial or near-axial series) they represent
 * essentially the same physical position, so scrubbing one and switching
 * to the other should land on the same slice, not jump to an unrelated
 * default. Sagittal/Coronal each still only reset to a fresh middle when
 * a genuinely new volume loads (`notifyVolumeLoaded`).
 *
 * The slider's `max`/default value can't be known until a volume is
 * loaded (dimensions are data-driven, unlike window/level's fixed clinical
 * HU defaults) -- `notifyVolumeLoaded()`/`notifyNativeVolumeLoaded()` are
 * called from main.ts once the loaded volume's dimensions are known,
 * mirroring the engine's own dimension/2-default-on-load behavior
 * (WebGPUDevice::loadVolume/loadNativeVolume). No readback export exists
 * from the engine for any of this state -- both sides just independently
 * agree on the same reset-to-middle-on-load convention, the same pattern
 * windowLevelControls.ts's PRESET_WINDOW_LEVELS comment already documents.
 *
 * User request, 2026-08-27: mouse wheel over the canvas scrubs the slice
 * slider while in a 2D view mode, instead of doing nothing -- the engine's
 * own `zoomCamera()` already no-ops outside Orbit3D (`viewMode_ !=
 * kViewModeOrbit3D` guard, WebGPUDevice.cpp), so a wheel event previously
 * just vanished in 2D Slice mode. `getViewMode()`/`stepSlice()` are
 * exported so cameraControls.ts's wheel handler (which owns the actual
 * `canvas.addEventListener("wheel", ...)`) can branch on the current mode
 * without this module needing to know anything about camera/zoom, or that
 * file needing its own view-mode tracking duplicated.
 */

import { bindRangeInput } from "./windowLevelControls.js";

export const VIEW_MODE_ORBIT_3D = 0;
export const VIEW_MODE_SLICE_2D = 1;
export const VIEW_MODE_NATIVE_SLICE_2D = 2;

export const SLICE_AXIS_AXIAL = 0;
export const SLICE_AXIS_SAGITTAL = 1;
export const SLICE_AXIS_CORONAL = 2;

let currentViewMode = VIEW_MODE_ORBIT_3D;
let currentSliceAxis = SLICE_AXIS_AXIAL;

// Set by notifyVolumeLoaded()/notifyNativeVolumeLoaded() -- see this
// module's own header comment for why both are needed (Slice2D's valid
// range depends on the primary volume's dimensions and current axis;
// NativeSlice2D's depends on the separately-loaded native volume's own
// depth).
let volumeWidth = 0;
let volumeHeight = 0;
let volumeDepth = 0;
let nativeVolumeDepth = 0;

// Remembered per mode/axis (2026-08-27 follow-up, see header comment) --
// Axial and Native intentionally share one value.
let sagittalIndex = 0;
let coronalIndex = 0;
let axialNativeIndex = 0;

export function getViewMode(): number {
  return currentViewMode;
}

/** Which dimension the current view mode/axis combination scrubs. */
function currentSliceDimension(): number {
  if (currentViewMode === VIEW_MODE_NATIVE_SLICE_2D) {
    return nativeVolumeDepth;
  }
  if (currentSliceAxis === SLICE_AXIS_SAGITTAL) {
    return volumeWidth;
  }
  if (currentSliceAxis === SLICE_AXIS_CORONAL) {
    return volumeHeight;
  }
  return volumeDepth;
}

/** The remembered index for the current mode/axis -- see this module's header comment for why Axial and Native share one. */
function getRememberedIndex(): number {
  if (currentViewMode === VIEW_MODE_SLICE_2D && currentSliceAxis === SLICE_AXIS_SAGITTAL) {
    return sagittalIndex;
  }
  if (currentViewMode === VIEW_MODE_SLICE_2D && currentSliceAxis === SLICE_AXIS_CORONAL) {
    return coronalIndex;
  }
  return axialNativeIndex; // Axial (Slice2D) or Native
}

function setRememberedIndex(value: number): void {
  if (currentViewMode === VIEW_MODE_SLICE_2D && currentSliceAxis === SLICE_AXIS_SAGITTAL) {
    sagittalIndex = value;
  } else if (currentViewMode === VIEW_MODE_SLICE_2D && currentSliceAxis === SLICE_AXIS_CORONAL) {
    coronalIndex = value;
  } else {
    axialNativeIndex = value;
  }
}

function sliceElements(): { slider: HTMLInputElement; label: HTMLElement } | null {
  const slider = document.getElementById("slice-index") as HTMLInputElement | null;
  const label = document.getElementById("slice-index-value");
  if (!slider || !label) {
    console.error("viewControls: #slice-index or #slice-index-value not found in the DOM");
    return null;
  }
  return { slider, label };
}

/**
 * Restores the current mode/axis's remembered index (clamped to its valid
 * range) into the slider and pushes it to the engine -- called after every
 * mode/axis switch and volume load. Explicitly re-applies via
 * applySliceIndex() rather than trusting the engine's own defaults:
 * setSliceAxis() resets the engine's Slice2D index to a fresh middle on
 * every call (by design, see rhi::Device::setSliceAxis), which this
 * function's whole job is to override with the *remembered* value instead
 * -- and NativeSlice2D needs the same explicit push since nothing else
 * re-syncs the slider's displayed value to it on a mode switch.
 */
function syncSliderToCurrentMode(): void {
  const elements = sliceElements();
  if (!elements) {
    return;
  }
  const dimension = currentSliceDimension();
  const maxIndex = Math.max(dimension - 1, 0);
  const clamped = Math.min(Math.max(getRememberedIndex(), 0), maxIndex);
  elements.slider.max = String(maxIndex);
  elements.slider.value = String(clamped);
  elements.label.textContent = String(clamped);
  setRememberedIndex(clamped);
  applySliceIndex(clamped);
}

// Clamps to the slider's own [min, max] (kept in sync with the current
// mode/axis by syncSliderToCurrentMode()) rather than letting the engine's
// own setter clamp silently -- the slider/label would otherwise go stale
// at the boundary (same class of desync bug windowLevelControls.ts's
// preset sync already exists to avoid).
export function stepSlice(delta: number): void {
  const elements = sliceElements();
  if (!elements) {
    return;
  }
  const min = Number(elements.slider.min);
  const max = Number(elements.slider.max);
  const next = Math.min(Math.max(Number(elements.slider.value) + delta, min), max);
  elements.slider.value = String(next);
  elements.label.textContent = String(next);
  setRememberedIndex(next);
  applySliceIndex(next);
}

function applySliceIndex(index: number): void {
  if (currentViewMode === VIEW_MODE_NATIVE_SLICE_2D) {
    window.Module._engine_set_native_slice_index(index);
  } else {
    window.Module._engine_set_slice_index(index);
  }
}

export function setupViewControls(): void {
  const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-view-mode]");
  const sliceRow = document.getElementById("slice-index-row");
  if (modeButtons.length === 0 || !sliceRow) {
    console.error("viewControls: [data-view-mode] buttons or #slice-index-row not found in the DOM");
    return;
  }

  function setActiveButton(mode: number, axis: number): void {
    modeButtons.forEach((button) => {
      const buttonMode = Number(button.dataset["viewMode"]);
      const buttonAxis = button.dataset["sliceAxis"] !== undefined ? Number(button.dataset["sliceAxis"]) : null;
      const isActive = buttonMode === mode && (buttonMode !== VIEW_MODE_SLICE_2D || buttonAxis === axis);
      button.classList.toggle("active", isActive);
    });
    sliceRow!.hidden = mode === VIEW_MODE_ORBIT_3D;
  }

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = Number(button.dataset["viewMode"]);
      const axis = button.dataset["sliceAxis"] !== undefined ? Number(button.dataset["sliceAxis"]) : SLICE_AXIS_AXIAL;

      currentViewMode = mode;
      window.Module._engine_set_view_mode(mode);
      if (mode === VIEW_MODE_SLICE_2D) {
        currentSliceAxis = axis;
        window.Module._engine_set_slice_axis(axis);
      }
      setActiveButton(mode, axis);
      syncSliderToCurrentMode();
    });
  });
  setActiveButton(VIEW_MODE_ORBIT_3D, SLICE_AXIS_AXIAL);

  bindRangeInput("slice-index", "slice-index-value", 0, (value) => {
    setRememberedIndex(value);
    applySliceIndex(value);
  });
}

export function notifyVolumeLoaded(width: number, height: number, depth: number): void {
  volumeWidth = width;
  volumeHeight = height;
  volumeDepth = depth;
  // A genuinely new volume load, not a mode switch -- this is the one
  // place all three remembered indices reset to a fresh middle (matching
  // the engine's own loadVolume() default), since a new series' previous
  // slice positions have no meaningful relationship to the new one.
  sagittalIndex = Math.floor(width / 2);
  coronalIndex = Math.floor(height / 2);
  axialNativeIndex = Math.floor(depth / 2);
  if (currentViewMode !== VIEW_MODE_NATIVE_SLICE_2D) {
    syncSliderToCurrentMode();
  }
}

export function notifyNativeVolumeLoaded(depth: number): void {
  nativeVolumeDepth = depth;
  if (currentViewMode === VIEW_MODE_NATIVE_SLICE_2D) {
    syncSliderToCurrentMode();
  }
}
