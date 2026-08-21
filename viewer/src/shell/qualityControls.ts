/**
 * REQ-R04 raymarch quality tier + gradient-shading toggle
 * (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md §4.1/§4.3) --
 * a 3-button tier selector calling `engine_set_quality_tier`, plus a
 * checkbox calling `engine_set_shading_enabled`, both directly and
 * synchronously on every event (no queueing needed -- see
 * cameraControls.ts's comment on why). Mirrors viewControls.ts's
 * setActiveMode pattern for the tier buttons' active-state feedback.
 *
 * Issue #69: also owns two automatic quality adjustments on top of the
 * user's own tier choice, both applied at the engine level without
 * touching the button UI (which always reflects userSelectedTier, what
 * the user actually picked, not what's momentarily rendering):
 *
 * - Interaction-adaptive: cameraControls.ts calls
 *   notifyInteractionStart()/notifyInteractionEnd() around its drag
 *   lifecycle so the active tier drops to Low only while the camera is
 *   actually being dragged. Dropped frames are most noticeable during
 *   interaction and least noticeable there too (a moving image masks
 *   the coarser sampling) -- the cheapest quality/perf trade available.
 * - Startup auto-downgrade: main.ts calls applyStartupAutoTier() once,
 *   after sampling wall-clock frame time for a few frames post-load. A
 *   phone whose *static* frame is already too slow gets no benefit from
 *   the interaction-only adaptation above -- this catches that case
 *   before the user has interacted at all. Deliberately keyed off
 *   getFrameStats() (wall-clock), not the GPU timestamp-query pass
 *   timing added in #63: that reading has been observed to report
 *   implausible values (individual pass times exceeding the total frame
 *   time) on at least one real Apple-GPU mobile browser, so wall-clock
 *   frame time is the only signal trusted to be comparable across
 *   browsers/GPUs for this decision.
 */

const DEFAULT_QUALITY_TIER = 1; // Medium -- matches WebGPUDevice's kDefaultQualityTier.
const INTERACTION_QUALITY_TIER = 0; // Low -- floor while actively dragging/orbiting.

let userSelectedTier = DEFAULT_QUALITY_TIER;
let interacting = false;
let tierButtons: NodeListOf<HTMLButtonElement> | null = null;

function setActiveTierButton(tier: number): void {
  tierButtons?.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset["qualityTier"]) === tier);
  });
}

export function notifyInteractionStart(): void {
  if (interacting || userSelectedTier <= INTERACTION_QUALITY_TIER) {
    return;
  }
  interacting = true;
  window.Module._engine_set_quality_tier(INTERACTION_QUALITY_TIER);
}

export function notifyInteractionEnd(): void {
  if (!interacting) {
    return;
  }
  interacting = false;
  window.Module._engine_set_quality_tier(userSelectedTier);
}

// Called once, shortly after load -- see main.ts's post-load frame-time
// sample. Only ever lowers the starting tier (never raises it above
// DEFAULT_QUALITY_TIER); a user who explicitly picks a higher tier
// afterward is always honored via the normal click handler below.
export function applyStartupAutoTier(tier: number): void {
  if (tier >= userSelectedTier) {
    return;
  }
  userSelectedTier = tier;
  setActiveTierButton(tier);
  if (!interacting) {
    window.Module._engine_set_quality_tier(tier);
  }
}

export function setupQualityControls(): void {
  tierButtons = document.querySelectorAll<HTMLButtonElement>("[data-quality-tier]");
  const shadingCheckbox = document.getElementById("shading-enabled") as HTMLInputElement | null;

  if (tierButtons.length === 0) {
    console.error("qualityControls: [data-quality-tier] buttons not found in the DOM");
  } else {
    tierButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const tier = Number(button.dataset["qualityTier"]);
        userSelectedTier = tier;
        setActiveTierButton(tier);
        // While a drag is in progress, the engine's active tier stays
        // pinned at INTERACTION_QUALITY_TIER -- notifyInteractionEnd()
        // applies userSelectedTier once the drag ends instead.
        if (!interacting) {
          window.Module._engine_set_quality_tier(tier);
        }
      });
    });
    setActiveTierButton(DEFAULT_QUALITY_TIER);
  }

  if (!shadingCheckbox) {
    console.error("qualityControls: #shading-enabled not found in the DOM");
  } else {
    shadingCheckbox.addEventListener("change", () => {
      window.Module._engine_set_shading_enabled(shadingCheckbox.checked ? 1 : 0);
    });
  }
}
