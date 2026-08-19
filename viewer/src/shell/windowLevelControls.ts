/**
 * Clinical window/level UI (issue #34, REQ-R06) -- two range sliders
 * (center/width) plus baseline preset buttons, calling the engine's
 * `engine_set_window_level`/`engine_set_colormap_preset` WASM exports
 * directly and synchronously on every input event (no queueing needed --
 * see cameraControls.ts's comment on why). Preset button order/values
 * must match `kColormapPresets` in
 * engine/src/rhi/backends/webgpu/src/WebGPUDevice.cpp exactly (0=Lung,
 * 1=Bone, 2=Soft Tissue, 3=Brain).
 *
 * Sliders initialize to the Soft Tissue preset's values (40/400) to
 * match `WebGPUDevice`'s own default-on-load preset -- no read-back
 * export from the engine exists (or is needed) to sync this; both sides
 * just agree on the same default independently, the same way
 * `kDefaultColormapPreset` is a plain constant on the C++ side.
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

export function setupWindowLevelControls(): void {
  let center = DEFAULT_WINDOW_CENTER;
  let width = DEFAULT_WINDOW_WIDTH;

  const applyWindowLevel = () => window.Module._engine_set_window_level(center, width);

  bindRangeInput("window-center", "window-center-value", DEFAULT_WINDOW_CENTER, (value) => {
    center = value;
    applyWindowLevel();
  });
  bindRangeInput("window-width", "window-width-value", DEFAULT_WINDOW_WIDTH, (value) => {
    width = value;
    applyWindowLevel();
  });

  const presetButtons = document.querySelectorAll<HTMLButtonElement>("[data-colormap-preset]");
  presetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const presetId = Number(button.dataset["colormapPreset"]);
      window.Module._engine_set_colormap_preset(presetId);
    });
  });
}
