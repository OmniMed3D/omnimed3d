/**
 * REQ-R04 raymarch quality tier + gradient-shading toggle
 * (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md §4.1/§4.3) --
 * a 3-button tier selector calling `engine_set_quality_tier`, plus a
 * checkbox calling `engine_set_shading_enabled`, both directly and
 * synchronously on every event (no queueing needed -- see
 * cameraControls.ts's comment on why). Mirrors viewControls.ts's
 * setActiveMode pattern for the tier buttons' active-state feedback.
 */

const DEFAULT_QUALITY_TIER = 1; // Medium -- matches WebGPUDevice's kDefaultQualityTier.

export function setupQualityControls(): void {
  const tierButtons = document.querySelectorAll<HTMLButtonElement>("[data-quality-tier]");
  const shadingCheckbox = document.getElementById("shading-enabled") as HTMLInputElement | null;

  function setActiveTier(tier: number): void {
    tierButtons.forEach((button) => {
      button.classList.toggle("active", Number(button.dataset["qualityTier"]) === tier);
    });
  }

  if (tierButtons.length === 0) {
    console.error("qualityControls: [data-quality-tier] buttons not found in the DOM");
  } else {
    tierButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const tier = Number(button.dataset["qualityTier"]);
        setActiveTier(tier);
        window.Module._engine_set_quality_tier(tier);
      });
    });
    setActiveTier(DEFAULT_QUALITY_TIER);
  }

  if (!shadingCheckbox) {
    console.error("qualityControls: #shading-enabled not found in the DOM");
  } else {
    shadingCheckbox.addEventListener("change", () => {
      window.Module._engine_set_shading_enabled(shadingCheckbox.checked ? 1 : 0);
    });
  }
}
