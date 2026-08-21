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
 * user's own choices, both applied at the engine level without touching
 * any control's UI (which always reflects the user's actual selection,
 * not what's momentarily rendering):
 *
 * - Interaction-adaptive: cameraControls.ts calls
 *   notifyInteractionStart()/notifyInteractionEnd() around its drag
 *   lifecycle so the active tier drops to Low, and shading/occlusion
 *   shading both force off, only while the camera is actually being
 *   dragged -- restored to the user's own selections on release.
 *   Dropped frames are most noticeable during interaction and least
 *   noticeable there too (a moving image masks the coarser sampling) --
 *   the cheapest quality/perf trade available. Shading and occlusion
 *   were added to this same mechanism after Mini-Engine-reference's own
 *   "adaptive SPP during camera motion" pattern showed the same
 *   interaction-gated idea generalizes to any per-sample cost, not just
 *   step count -- occlusion in particular does its own extra sampling
 *   per step (see tfDetailControls.ts), so it's one of the more
 *   expensive toggles to leave on during a drag.
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

// Must match WebGPUDevice's own member defaults (shadingEnabled_=true,
// occlusionEnabled_=false) -- see tfDetailControls.ts's header comment
// for why there's no readback export and both sides just agree
// independently.
let userSelectedTier = DEFAULT_QUALITY_TIER;
let userSelectedShadingEnabled = true;
let userSelectedOcclusionEnabled = false;
let interacting = false;
let tierButtons: NodeListOf<HTMLButtonElement> | null = null;

function setActiveTierButton(tier: number): void {
  tierButtons?.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset["qualityTier"]) === tier);
  });
}

// Applies the current effective state to the engine -- the user's own
// selections while idle, or the interaction floor (Low tier, shading
// and occlusion both off) while a drag is in progress. Called on every
// state change (tier/shading/occlusion selection, or entering/leaving
// interaction) rather than diffing what actually changed -- these are
// infrequent UI-driven calls, not per-frame, so the redundant WASM calls
// this occasionally causes (e.g. re-asserting occlusion=off on drag
// start when it was already off) cost nothing worth avoiding the extra
// bookkeeping for.
function applyEngineState(): void {
  window.Module._engine_set_quality_tier(interacting ? INTERACTION_QUALITY_TIER : userSelectedTier);
  window.Module._engine_set_shading_enabled(interacting ? 0 : userSelectedShadingEnabled ? 1 : 0);
  window.Module._engine_set_occlusion_enabled(interacting ? 0 : userSelectedOcclusionEnabled ? 1 : 0);
}

export function notifyInteractionStart(): void {
  if (interacting) {
    return;
  }
  interacting = true;
  applyEngineState();
}

export function notifyInteractionEnd(): void {
  if (!interacting) {
    return;
  }
  interacting = false;
  applyEngineState();
}

// Called from tfDetailControls.ts's occlusion checkbox handler instead
// of that file calling engine_set_occlusion_enabled directly -- routes
// the selection through the same interaction-aware gate the tier
// buttons and shading checkbox already use below, so a checkbox toggle
// mid-drag updates the *stored* selection immediately but doesn't
// re-enable occlusion on the engine until the drag ends.
export function notifyOcclusionSelection(enabled: boolean): void {
  userSelectedOcclusionEnabled = enabled;
  if (!interacting) {
    applyEngineState();
  }
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
    applyEngineState();
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
          applyEngineState();
        }
      });
    });
    setActiveTierButton(DEFAULT_QUALITY_TIER);
  }

  if (!shadingCheckbox) {
    console.error("qualityControls: #shading-enabled not found in the DOM");
  } else {
    shadingCheckbox.addEventListener("change", () => {
      userSelectedShadingEnabled = shadingCheckbox.checked;
      if (!interacting) {
        applyEngineState();
      }
    });
  }
}
