/**
 * Mobile OOM mitigation (Option B): surfaces WebGPU device-loss and
 * uncaptured-error events (rhi::Device::getDeviceLossState) instead of
 * failing silently -- previously nothing reacted to either, so a real
 * GPU-level failure just left a frozen canvas with no explanation.
 *
 * Rare/terminal events, not per-frame state -- polled on a plain
 * `setInterval`, not piggybacked on statsOverlay.ts's rAF loop (which
 * also only runs while that debug panel is visible; this needs to work
 * regardless of whether a developer has that panel open).
 *
 * No auto-recovery attempted for device loss: re-initializing would mean
 * re-requesting the adapter/device, recreating every pipeline/texture,
 * and re-uploading volume/mask data the Shell doesn't keep cached
 * JS-side once handed to WASM (engineLoadVolume's malloc/free-per-call
 * pattern) -- materially bigger scope than "handle the event". A reload
 * is an honest, low-risk response instead.
 */

const POLL_INTERVAL_MS = 300;

export function setupDeviceLostBanner(): void {
  const banner = document.getElementById("device-lost-banner");
  const bannerMessage = document.getElementById("device-lost-banner-message");
  const reloadButton = document.getElementById("device-lost-banner-reload");
  const toast = document.getElementById("uncaptured-error-toast");
  const toastMessage = document.getElementById("uncaptured-error-toast-message");
  const dismissButton = document.getElementById("uncaptured-error-toast-dismiss");
  if (!banner || !bannerMessage || !reloadButton || !toast || !toastMessage || !dismissButton) {
    console.error("deviceLostBanner: one or more #device-lost-banner-*/#uncaptured-error-toast-* not found");
    return;
  }

  let bannerShown = false;
  let toastShown = false;

  reloadButton.addEventListener("click", () => location.reload());
  dismissButton.addEventListener("click", () => {
    toast.hidden = true;
    toastShown = false; // lets a later, different uncaptured error show its own toast
    window.Module._engine_clear_uncaptured_error();
  });

  setInterval(() => {
    if (!bannerShown && window.Module._engine_get_device_lost() === 1) {
      bannerShown = true;
      const message = window.Module.UTF8ToString(window.Module._engine_get_device_lost_message());
      if (message) {
        bannerMessage.textContent = `Rendering stopped unexpectedly: ${message}`;
      }
      banner.hidden = false;
    }
    // Once a device is lost, an uncaptured error alongside it isn't
    // worth a separate toast -- the banner above already covers it.
    if (!bannerShown && !toastShown && window.Module._engine_get_uncaptured_error() === 1) {
      toastShown = true;
      toastMessage.textContent = window.Module.UTF8ToString(window.Module._engine_get_uncaptured_error_message());
      toast.hidden = false;
    }
  }, POLL_INTERVAL_MS);
}
