/**
 * Detects whether this JS engine is WebKit -- iOS (any browser, since
 * Apple mandates WebKit under the hood regardless of browser brand: Chrome
 * for iOS, Firefox for iOS, etc. all run on it too) or desktop macOS
 * Safari specifically (not Chrome/Firefox/Edge on macOS, which use their
 * own engines).
 *
 * Real-device and real-browser testing (docs/ai-track-decisions.md,
 * 2026-08-26 sessions) found the onnxruntime-web/WebKit JIT bug (upstream:
 * microsoft/onnxruntime#26827) reproduces on both:
 * - iOS (original discovery, iPhone 14 Pro + Chrome and Safari)
 * - macOS desktop Safari (confirmed later the same day, on an M1 Pro: a
 *   WASM-only run still using the JSEP-variant WASM bundle showed the same
 *   intermittent multi-second stall pattern iOS did (one batch's infer()
 *   spiked from a ~750ms baseline to ~42s before partially recovering);
 *   separately, a WebGPU run never crashed but was a flat ~12-14x slower
 *   than the same model on the same machine's Chrome, for its entire run)
 *
 * No feature-detectable signal exists for either of these (it's a specific
 * JS engine bug and a specific WebGPU implementation's performance, not a
 * capability gap) -- UA sniffing is the pragmatic option here, same
 * reasoning as Engine's `deviceTier.ts`'s `isLikelyIOS()`, which the iOS
 * half of this mirrors.
 *
 * Known gap: an iPad running a non-Safari browser (e.g. Chrome for iPad)
 * that also happens to present a desktop-masquerading Mac UA would slip
 * through both checks below. Not handled -- `navigator.maxTouchPoints`
 * (which could disambiguate a real Mac from an iPad-as-Mac) isn't exposed
 * on `WorkerNavigator` in either Chromium or WebKit (confirmed directly
 * via a real Worker in both, not assumed) -- and moot regardless: real
 * desktop macOS Safari is now routed the same way as iPad Safari, so
 * disambiguating "real Mac" from "iPad pretending to be a Mac" is no
 * longer a distinction that changes the outcome for a Safari-branded UA.
 * It would only matter for an iPad running a *non*-Safari browser, which
 * is the gap that remains.
 *
 * Takes `userAgent` as an explicit parameter (rather than reading
 * `navigator.userAgent` internally) so this stays a pure function,
 * unit-testable without a real `navigator` -- same reasoning as
 * modelSelection.ts's exports; worker.ts owns passing in the real value.
 */
export function isWebKitForced(userAgent: string): boolean {
  const isIOS = /iP(hone|ad|od)/.test(userAgent);
  const isMacSafari =
    /Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg|OPR|CriOS|FxiOS/.test(userAgent);
  return isIOS || isMacSafari;
}
