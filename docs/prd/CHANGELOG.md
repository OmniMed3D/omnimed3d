# PRD Changelog

`docs/prd/PRD.md` was local-only (gitignored) until this entry. This file
starts version-controlled tracking of it going forward — each entry below
records what changed between one committed snapshot and the next, in
addition to whatever "Last Updated" date `PRD.md`'s own header table
carries.

## First git-tracked snapshot — 2026-08-16

This is the first version of `PRD.md` committed to git. Before this, the
document had already reached Version v0.9 (Last Updated 2026-08-12)
through local-only edits carried between machines manually (see
`docs/current/SESSION_STATUS_2026-08-16.md`'s handoff notes) — none of
that prior history is in git. What follows is the delta between that
last pre-git snapshot and this first committed one, made while resolving
GitHub issue #21's two agenda items (REQ-C01 schema ownership, and the
`viewer/` root toolchain decision):

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
