/**
 * Device-tier detection for the gradient volume low-memory fallback
 * (Engine's `_engine_load_volume` `lowMemoryMode` argument -- see
 * `engine/docs/RENDERING_SPEC.md`'s 2026-08-24 entry and
 * `docs/current/OPTION_A_GRADIENT_LOW_MEMORY_EXPLAINER_2026-08-24.md`).
 * Decided once, at volume-load time, from whatever device signal is
 * actually available -- there is no way to change this mid-session
 * without reloading the volume, since it controls what size GPU texture
 * gets allocated.
 *
 * Real, reproduced motivation: an iPhone 14 Pro + Chrome (WebKit on iOS)
 * OOM-crashed running rendering + FP16 inference concurrently. `navigator
 * .deviceMemory` (the Device Memory API) is the feature-detectable signal
 * this project generally prefers over UA sniffing -- but Apple does not
 * implement it on iOS Safari/WebKit at all (confirmed: no feature-
 * detectable replacement exists for "is this iOS"), which is exactly the
 * device class this whole investigation is about. UA sniffing here is a
 * deliberate, narrow exception to that preference, not a precedent for
 * using it elsewhere.
 */

declare global {
  interface Navigator {
    // Device Memory API (https://w3c.github.io/device-memory/) -- not in
    // TS's standard DOM lib, and not implemented by Safari/WebKit at all
    // (Apple has stated no intent to ship it), so this is always
    // `undefined` on iOS regardless of the actual device's real memory.
    deviceMemory?: number;
  }
}

// Below this many GB of total device memory, treat the device as memory-
// constrained. 4GB is a common rough tier line for "entry-level mobile" --
// chosen jointly with the AI track, since their own device-tier work
// assumes the same number.
const LOW_MEMORY_THRESHOLD_GB = 4;

function isLikelyIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

/**
 * Diagnostic-only override (?lowMemory=1 or ?lowMemory=0 on the URL),
 * same pattern as canvasResize.ts's ?dpr=<n> -- lets a real-device
 * retest force either mode without needing navigator.deviceMemory to
 * actually report a matching value (e.g. verifying the fallback on a
 * desktop dev machine, or forcing full mode on a phone to A/B against
 * the auto-detected low-memory mode).
 */
function urlOverride(): boolean | null {
  const value = new URLSearchParams(location.search).get("lowMemory");
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

// User-facing override (the "Low-Memory Mode" checkbox in the Rendering
// panel section) -- takes precedence over even the URL param, since it's
// the most recent explicit choice within the session. `null` means "no
// manual choice made yet, defer to the URL param / auto-detection".
let manualOverride: boolean | null = null;

export function setManualLowMemoryOverride(value: boolean): void {
  manualOverride = value;
}

export function shouldUseLowMemoryMode(): boolean {
  if (manualOverride !== null) {
    return manualOverride;
  }
  const override = urlOverride();
  if (override !== null) {
    return override;
  }
  if (navigator.deviceMemory !== undefined) {
    return navigator.deviceMemory <= LOW_MEMORY_THRESHOLD_GB;
  }
  return isLikelyIOS();
}

// Wires the checkbox to the override above. Deliberately does NOT
// re-load any already-loaded volume -- lowMemoryMode controls what size
// GPU texture gets allocated at load time (see this file's header
// comment), so a live toggle would need to re-request the original
// volume bytes, which the Shell doesn't keep cached JS-side once handed
// to WASM (and caching a duplicate copy purely to support this would
// undercut the whole point of a *memory*-saving feature). The checkbox
// reflects/sets tomorrow's load, not today's already-rendered one --
// see its tooltip text (tooltipManager.ts) for the user-facing framing
// of that limitation.
export function setupLowMemoryModeControl(): void {
  const checkbox = document.getElementById("low-memory-mode-enabled") as HTMLInputElement | null;
  if (!checkbox) {
    console.error("deviceTier: #low-memory-mode-enabled not found in the DOM");
    return;
  }
  // Reflects the URL-param/auto-detected starting point (manualOverride
  // is still null at this point in startup), so the checkbox shows what
  // would actually happen before the user has touched it.
  checkbox.checked = shouldUseLowMemoryMode();
  checkbox.addEventListener("change", () => {
    setManualLowMemoryOverride(checkbox.checked);
  });
}
