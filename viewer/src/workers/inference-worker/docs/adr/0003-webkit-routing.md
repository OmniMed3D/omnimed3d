# ADR-0003: WebKit (iOS + macOS Safari) always gets WASM+INT8, never WebGPU/JSEP

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-27 |

## Context

A real-device mobile OOM crash (iPhone 14 Pro, Chrome and Safari) traced
back to a WebKit-specific bug in onnxruntime-web's JSEP (WebGPU) backend —
upstream: [microsoft/onnxruntime#26827](https://github.com/microsoft/onnxruntime/issues/26827),
a JavaScriptCore JIT compiler pathology that grows memory from ~1GB to
14GB and eventually kills the page. The issue thread's own text ("standard
WASM backend works correctly in all configurations" vs. "JSEP configs —
webgpu, wasm, or both together — all have the same behavior") means the
safe boundary is *which entry bundle gets loaded*, not which execution
provider ends up selected: merely importing `onnxruntime-web/webgpu`
carries the risk even if `executionProviders` never lists `"webgpu"`.

`gpuDetected` (`navigator.gpu.requestAdapter()`) is not a usable signal
for this — it answers "is a WebGPU adapter available," not "does this JS
engine have this bug." A WebKit device with a perfectly working adapter
still needs to avoid the JSEP bundle entirely.

Scope was initially assumed to be iOS-only. Verified otherwise on
2026-08-27, on a real M1 Pro running desktop Safari:

- With WebGPU not yet enabled (`gpuDetected: false`, but the JSEP bundle
  still loaded, since import selection wasn't yet environment-aware): a
  60-batch INT8/WASM run was stable at ~700-900ms/batch through batch 27,
  then spiked to 6209ms (batch 28) and 41745ms (batch 29) before partially
  recovering — the same intermittent-stall signature as the original iOS
  findings.
- With WebGPU enabled (FP16, `executionProviders: ["webgpu","wasm"]`): no
  crash, but a flat ~2800-3500ms/batch for the entire 60-batch run — about
  12-14x slower than the same model on the same machine's Chrome
  (~242ms/batch, `docs/ai-track-decisions.md`, 2026-08-21 measurement).

Both results point the same direction independent of each other (one a
crash-adjacent stability failure, the other a stable-but-unusable
performance floor), so desktop Safari is included, not just iOS.

## Decision

- `environment.ts`'s `isWebKitForced(userAgent)`: `true` for iOS (any
  browser — Apple mandates WebKit under the hood there regardless of
  brand, confirmed by the original bug reproducing under iOS Chrome, not
  just iOS Safari) **or** desktop macOS Safari specifically (`Macintosh`
  + `Safari` in the UA, excluding Chrome/Chromium/Edge/Opera/CriOS/FxiOS
  markers so desktop Chrome/Firefox/Edge on macOS are unaffected). Takes
  `userAgent` as an explicit parameter rather than reading `navigator`
  internally, so it stays unit-testable without a real browser.
- `modelSelection.ts`'s `resolveEffectiveGpuDetected(debugForce, gpuDetected, isWebKitForced)`:
  when `isWebKitForced` is true, the effective result is always `false`
  (INT8 model, no WebGPU) regardless of `gpuDetected` — unless a
  `debugForce` override says otherwise (see below).
- `worker.ts`: which entry bundle loads — `onnxruntime-web` (no WebGPU
  registered) or `onnxruntime-web/webgpu` (JSEP) — is decided by a
  dynamic `import()` inside the `init` handler, from that same
  `effectiveGpuDetected` value, not a static top-level import. A WebKit
  session never evaluates the JSEP bundle at all, which is the actual
  fix per the upstream issue's own distinction above — narrowing
  `executionProviders` alone (which is all a purely EP-based fix could
  do) would not have been sufficient.
- A debug-only override (`InitMessage.debugForce: "wasm-int8" | "gpu-fp16"`,
  reachable via the Shell's `?aiForce=` URL param) can force either path
  regardless of the real environment — including forcing `"gpu-fp16"` on
  a genuine WebKit device on purpose, to reproduce or regression-test the
  failure this ADR routes around. Not a production/user-facing control.

## Consequences

- iOS and macOS Safari users always get INT8+WASM. This is a structural,
  accepted ceiling, not a target for further tuning: PRD §4's <500ms/slice
  budget is not met on this path (iOS measurement: ~2.3s/slice average
  over a 133-slice run, 2026-08-26) and is not expected to be — the
  bottleneck is WebKit's JIT behavior, not this project's code, so
  further optimization effort here is not a good use of time.
- Android/desktop non-WebKit browsers are entirely unaffected — same
  `gpuDetected`-driven FP16-WebGPU-when-available behavior as before this
  ADR.
- The Shell (`main.ts`/`inferenceControls.ts`, Engine-owned) needed no
  changes for this beyond what the pre-existing `?aiForce=` plumbing
  already carried (PR #120) — consistent with the boundary that hardware/
  environment detection is this worker's own responsibility, not
  something Shell branches on.
- Known detection gap, documented in `environment.ts`: an iPad running a
  non-Safari browser (e.g. Chrome for iPad) that also presents a
  desktop-masquerading Mac UA is not caught by either check.
  `navigator.maxTouchPoints` (which could disambiguate a real Mac from an
  iPad pretending to be one) is not exposed on `WorkerNavigator` in either
  Chromium or WebKit — confirmed directly via a real `Worker` in both, not
  assumed. Largely moot regardless: since real desktop Safari is now
  routed the same way as iPad Safari, disambiguating "real Mac" from
  "iPad-as-Mac" no longer changes the outcome for any Safari-branded UA;
  the residual gap is narrower (non-Safari browser + masquerading UA)
  than it would otherwise be.
- Root cause of Safari's ~12-14x WebGPU slowdown (distinct from the
  crash-adjacent JSEP-load issue this ADR fixes) is not diagnosed —
  doesn't block this decision since WebKit never reaches that code path
  after this change, but is left as an open question if ever relevant
  again (e.g. if Safari's WebGPU implementation matures enough to
  reconsider this ADR).

## Alternatives Considered

- **iOS-only scope** (the original assumption). Rejected once the
  2026-08-27 desktop Safari measurement reproduced both failure modes —
  keeping the narrower scope would have left desktop Safari on a session
  that spikes to 40+ seconds mid-run.
- **Feature-detect the bug instead of UA-sniffing.** No such signal
  exists — this is a specific JS engine defect, not a capability gap, so
  there is nothing to query via `navigator`/WebGPU/WASM feature checks.
  UA sniffing is the pragmatic option here, same reasoning Engine's
  `deviceTier.ts`'s `isLikelyIOS()` already uses for the iOS half of this
  same problem space.
- **Runtime fallback**: detect a WebGPU failure/stall mid-session (after
  `init-complete`) and hot-swap to a wasm-only session. Rejected as
  unnecessary complexity for a scenario with no observed evidence outside
  WebKit — routing WebKit away from WebGPU at the source (this ADR)
  removes the only case where this was ever seen, so building a general
  runtime-recovery mechanism now would be speculative engineering against
  a failure mode that, post-fix, has nowhere left to occur.
