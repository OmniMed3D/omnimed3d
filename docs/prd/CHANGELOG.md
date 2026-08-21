# PRD Changelog

`docs/prd/PRD.md` was local-only (gitignored) until this entry. This file
starts version-controlled tracking of it going forward — each entry below
records what changed between one committed snapshot and the next, in
addition to whatever "Last Updated" date `PRD.md`'s own header table
carries.

## 2026-08-21 (later same day) — Accuracy degradation threshold team-confirmed

The proposal from the entry directly below ("Acceptable Accuracy
Degradation Threshold") was confirmed by the team (Engine track) the same
day it was proposed. §10.2's row now reads **Resolved** instead of
pending — no change to the numbers themselves (mean Dice degradation
≤ 1.0pp, no slice below 0.98 Dice), just the status.

## 2026-08-21 — Two §10.2 open questions closed out (one resolved, one proposed)

Both prompted by the AI track revisiting its own open items after wrapping
up Issue #35 (WebGPU EP) and its follow-ups (fallback recovery, warmup,
batched inference) — see `docs/verification/inference-worker.md` for the
underlying measurements both of these cite.

- **§10.2 "Upscaling Computation Location" row: resolved.** Decided a WASM
  loop over a WebGPU compute shader — `docs/verification/inference-worker.md`
  §3 measured postprocess (argmax + Nearest-Neighbor upscale) at 1-4ms per
  slice across all three model variants, negligible next to this stage's
  own >200ms inference time and nowhere near threatening the §4 500ms/slice
  target that motivated the question. This was already this track's own
  call per the row's original Decision Owner ("AI Track — to be decided
  based on empirical measurement"), so marked Resolved directly.
- **§10.2 "Acceptable Accuracy Degradation Threshold" row: a concrete
  number proposed, not unilaterally resolved.** Unlike the row above, this
  one's Decision Owner was "Open for team alignment" — the whole team, not
  just this track — so it's marked as a pending proposal rather than
  Resolved. Proposal: mean Dice degradation ≤ 1.0 percentage point vs. the
  FP32 reference, and no individual evaluated slice below 0.98 Dice for
  either class (a two-part mean+floor criterion, not mean-only, so one
  badly-degraded outlier slice can't hide inside an average of many
  near-perfect ones). Backed by `docs/verification/inference-worker.md`
  §4's measured data: INT8's worst case (right-lung Dice mean 0.9985, min
  0.9931) clears both parts of the proposed threshold with real margin;
  FP16 is effectively at parity. Needs actual team confirmation before
  this row flips to Resolved.

## First git-tracked snapshot — 2026-08-16

This is the first version of `PRD.md` committed to git. Before this, the
document had already reached Version v0.9 (Last Updated 2026-08-12)
through local-only edits carried between machines manually (see
`docs/current/SESSION_STATUS_2026-08-16.md`'s handoff notes) — none of
that prior history is in git. What follows is the delta between that
last pre-git snapshot and this first committed one, made while resolving
GitHub issue #20's Step 0 ("Finalize Mask Data Contract and Rendering
Integration") — REQ-C01 schema ownership, and the `viewer/` root toolchain
decision Step 2 later depends on. (Correction: the commit that introduced
this file, `91e4b30`, mislabeled this as "issue #21" — that commit is
already merged to `main` and its message is left as historical record;
this note is the correction.)

- **§5.3.1 "Engine Integration Point" row:** reworded from tracking the
  mask compositor as separately-flagged "new engine work" to describing
  it as a settled part of the engine's design (it had in fact already
  landed — `WebGPUDevice::applyMaskSlice`, commit `05534b3`, same day as
  the prior PRD update). The row now names the actual remaining gap
  instead: the Web Application Shell that calls into this compositor
  (§5.3.2) doesn't exist yet.
- **§6.2 diagram, `M` node label:** `"(New Work, Receives H Progressively
  Per-Brick)"` → `"(Full-Resolution 3D Mask Texture, Receives H
  Progressively Per-Slice)"`, matching the MVP full-resolution-texture
  transport model §5.3.1/§5.3.2 already describe elsewhere, and dropping
  the "new work" framing for the same reason as above.
- **§6.2 "Note on transport ownership":** dropped the `(Proposed,
  2026-08-12)` qualifier and "proposed contract" → "contract" — §5.3.2
  itself already carries `Status: Decided` (AI Track confirmed
  2026-08-12); this note just hadn't been updated to match.
- **§6.1 "AI Inference Integration Interface" row:** dropped the trailing
  `(Proposed)` qualifier on the §5.3.2 citation, same reason.
- **§6.1 "Web Application Shell" row:** added the resolution of issue
  #21's second agenda item — the Shell, Parse Worker, and Inference
  Worker will be Vite-built npm workspace members under a single
  `viewer/package.json` root, rather than three independently-installed
  packages. Noted that root build config remains a joint Engine/AI-track
  decision per `docs/adr/0003-inference-worker-in-viewer.md`'s
  consequences, and that this doesn't change `inference-worker/`'s
  existing `CODEOWNERS` override.
- **Appendix A, REQ-R05 row:** `"...dependent on REQ-C01 contract
  finalization"` → `"...built directly against the REQ-C01 contract
  (§5.3.1/§5.3.2)"` — the contract isn't a pending dependency anymore,
  it's the settled spec the compositor was built against.
