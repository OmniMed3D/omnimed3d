---
target: viewer/src/shell control panel
total_score: 14
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-19T08-41-51Z
slug: viewer-src-shell-index-html
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | No loading/progress indicator anywhere during parse or load |
| 2 | Match System / Real World | 2 | Two unexplained file-input buttons; status text is engineer-facing |
| 3 | User Control and Freedom | 2 | No cancel during load, no reset-to-preset, panel can't be dismissed |
| 4 | Consistency and Standards | 2 | View-mode buttons get an .active state; colormap presets (same pattern) don't |
| 5 | Error Prevention | 1 | Folder picker has no file-type filter at all |
| 6 | Recognition Rather Than Recall | 1 | Confirmed bug: preset clicks desync window/level sliders from engine state |
| 7 | Flexibility and Efficiency | 2 | No numeric direct-entry for window/level |
| 8 | Aesthetic and Minimalist Design | 2 | Minimal but unfinished-looking (native vs custom control mismatch) |
| 9 | Error Recovery | 0 | No user-visible error path; WebGPU-unavailable device sees a frozen loading screen forever |
| 10 | Help and Documentation | 1 | No first-touch guidance on the empty canvas |
| **Total** | | **14/40** | **Poor** |

## Design Specificity Verdict
Reads as a generic dark-mode admin panel with clinical vocabulary pasted onto its labels, not a UI authored for a volumetric medical viewer. CLI detector ran degraded (missing parser modules, 0 findings, undercount per its own output). Live browser-injected detector fired flat-type-hierarchy in both empty and loaded states, corroborating the LLM's own typography observation.

## Priority Issues
- [P0] Canvas is a fixed 640x480 pixel box, not responsive -- index.html hardcodes width/height, no CSS sizing rule, no resize handler anywhere.
- [P0] Silent, permanent failure when WebGPU is unavailable -- requestAdapter() null leaves the app stuck at "shell: loading..." forever with no user-facing message.
- [P1] Colormap preset clicks desync the window/level sliders from actual engine state (verified directly against windowLevelControls.ts) -- preset click only calls _engine_set_colormap_preset, never updates the center/width closure or slider UI, so the next manual slider drag silently overwrites the preset with stale values.
- [P1] No loading feedback during file parse/volume load -- no disabled state, no progress indicator between file selection and render.
- [P2] Touch targets undersized (~25-30px) for the PRODUCT.md-confirmed glove-operable mobile requirement (44px/48dp minimum).

## Persona Red Flags
- Alex (power user): no numeric direct-entry for window/level; preset click can silently corrupt a manually-dialed value.
- Sam (accessibility): no :focus-visible styling anywhere; no aria-pressed/aria-live backing the mode toggle or loading state.
- Rushed EMS/mobile-clinic (project-specific): unlabeled dual file-input buttons, sub-30px touch targets, canvas may not fit phone viewport, zero error message on WebGPU/parse failure.

## Minor Observations
No section headings; no :active button feedback; debug #status/#shell-status divs visible in loaded state; range-input thumbs use default blue accent clashing with the navy palette; CLI detector environment needs its parser modules fixed.
