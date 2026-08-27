/**
 * "Reload Volume" button. Low-Memory Mode and Downsample Factor
 * (deviceTier.ts) are both load-time-only settings --
 * toggling either after a volume is already loaded has no visible effect
 * until the volume loads again, and until this button existed there was
 * no way to trigger that short of re-picking the same file(s) from a
 * native file dialog (tedious) or re-fetching Demo CT (previously
 * impossible at all -- demoCtControls.ts permanently disables its own
 * button on success).
 *
 * Deliberately doesn't retain the volume's raw bytes to do this (that
 * would undercut Low-Memory Mode's own point -- see deviceTier.ts's
 * header comment on why the Shell doesn't cache a duplicate copy
 * JS-side). Instead, each loader registers a cheap closure via
 * `setReloadAction()` describing how to redo *itself*: main.ts's
 * `loadVolumeFromFiles()` re-reads from the original `File[]` handles
 * (the File API is disk/blob-backed, not an in-memory copy), and
 * demoCtControls.ts's registered action just re-runs its own `fetch()`
 * sequence. Both are "re-do the same work," not "replay cached bytes."
 */

let reloadAction: (() => void) | null = null;
let button: HTMLButtonElement | null = null;

/** Call whenever a volume load is kicked off, from whichever loader started it. */
export function setReloadAction(action: (() => void) | null): void {
  reloadAction = action;
  if (button) {
    button.disabled = action === null;
  }
}

export function setupReloadVolumeControl(): void {
  const el = document.getElementById("reload-volume") as HTMLButtonElement | null;
  if (!el) {
    console.error("reloadVolumeControl: #reload-volume not found in the DOM");
    return;
  }
  button = el;
  button.disabled = reloadAction === null;
  button.addEventListener("click", () => {
    reloadAction?.();
  });
}
