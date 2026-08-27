/**
 * True for iOS specifically (any browser -- Apple mandates WebKit under
 * the hood there regardless of brand), as distinct from `isWebKitForced()`
 * below (iOS + desktop macOS Safari together). Exported on its own because
 * not every WebKit-specific decision applies equally to both halves --
 * `worker.ts`'s `MAX_BATCH_SIZE` is the concrete example: a batch size that
 * reliably crashes on real iOS hardware was confirmed stable on desktop
 * Safari, so capping desktop Safari to the iOS-safe value too would cost
 * real throughput for a risk direct testing didn't confirm.
 */
export function isIOS(userAgent: string): boolean {
  return /iP(hone|ad|od)/.test(userAgent);
}

/**
 * Detects whether this JS engine is WebKit -- iOS (see isIOS() above) or
 * desktop macOS Safari specifically (not Chrome/Firefox/Edge on macOS,
 * which use their own engines).
 *
 * Real-device and real-browser testing found the onnxruntime-web/WebKit
 * JIT bug (upstream: microsoft/onnxruntime#26827) reproduces on both iOS
 * and macOS desktop Safari, so both need to be routed away from the
 * WebGPU (JSEP) bundle the same way.
 *
 * No feature-detectable signal exists for this (it's a specific JS engine
 * bug, not a capability gap) -- UA sniffing is the pragmatic option here,
 * same reasoning as Engine's `deviceTier.ts`'s `isLikelyIOS()`.
 *
 * Known gap: an iPad running a non-Safari browser that presents a
 * desktop-masquerading Mac UA would slip through both checks below.
 * `navigator.maxTouchPoints` (which could disambiguate a real Mac from an
 * iPad-as-Mac) isn't exposed on `WorkerNavigator` in either engine, and is
 * moot anyway since desktop macOS Safari is now routed the same way as
 * iPad Safari.
 *
 * Takes `userAgent` as an explicit parameter (rather than reading
 * `navigator.userAgent` internally) so this stays a pure function,
 * unit-testable without a real `navigator` -- worker.ts owns passing in
 * the real value.
 */
export function isWebKitForced(userAgent: string): boolean {
  const isMacSafari =
    /Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg|OPR|CriOS|FxiOS/.test(userAgent);
  return isIOS(userAgent) || isMacSafari;
}
