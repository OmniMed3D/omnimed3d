/**
 * Raymarch background color presets (rhi::Device::setBackgroundColor) --
 * purely cosmetic (no clinical window/level meaning), so plain RGB presets
 * rather than an engine-owned enum like setColormapPreset's 0-3 range --
 * matches setCustomColormap's direct-RGB shape instead. Mirrors
 * qualityControls.ts's tier-button active-state pattern.
 */

const PRESETS: Record<string, [number, number, number]> = {
  dark: [0.05, 0.05, 0.12], // matches the engine's own pre-existing default
  black: [0, 0, 0],
  gray: [0.5, 0.5, 0.5],
  white: [1, 1, 1],
};

const DEFAULT_PRESET = "dark";

export function setupBackgroundControls(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-background-preset]");
  if (buttons.length === 0) {
    console.error("backgroundControls: [data-background-preset] buttons not found in the DOM");
    return;
  }

  function setActive(preset: string): void {
    buttons.forEach((button) => {
      button.classList.toggle("active", button.dataset["backgroundPreset"] === preset);
    });
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const preset = button.dataset["backgroundPreset"] ?? DEFAULT_PRESET;
      const [r, g, b] = PRESETS[preset] ?? PRESETS[DEFAULT_PRESET]!;
      window.Module._engine_set_background_color(r, g, b);
      setActive(preset);
    });
  });

  setActive(DEFAULT_PRESET);
}
