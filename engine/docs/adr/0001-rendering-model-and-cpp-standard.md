# ADR-0001: Rendering model, resource-state ownership, and C++ standard

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-10 |

## Context

`engine/src/` does not exist yet — this ADR fixes the foundational rules
before the first line of engine code is written, per
`docs/current/OMNIMED3D_NEW_ENGINE_DRAFT_2026-08-03.md` §1–3 and `CLAUDE.md`
§8 ("Barriers and sync", "Render graph").

Nearly every Mini-Engine incident documented in
`Mini-Engine-reference/docs/archive/changelogs/` traced back to a bypass path
around render-graph or frame-barrier discipline existing in the first place —
this ADR exists to close that path structurally rather than by convention.

`CLAUDE.md` §2 also flagged an open item: whether the target C++ standard is
C++20 (per `CLAUDE.md` §2 and the current PRD) or C++17 (per an
earlier-described Mini-Engine-port framing). As of this ADR, `docs/prd/PRD.md`
§6.1 and Appendix A both state C++20 with no remaining C++17 reference
(verified by grep across the current PRD text) — the two documents no longer
disagree. This ADR records that resolution formally rather than leaving it as
an "assumed" figure.

## Decision

1. **Language standard: C++20.** RHI backend contracts are expressed as
   C++20 concepts (`CLAUDE.md` §2), which requires this floor regardless of
   any historical C++17 framing.

2. **Rendering model: Vulkan Dynamic Rendering, unified.** No render-pass /
   framebuffer objects. Dynamic Rendering has no implicit layout transitions,
   so barrier discipline (below) is not optional scaffolding — it is the only
   thing standing in for what render-pass objects used to do implicitly.

3. **One render graph owns 100% of GPU resource-state transitions,
   engine-wide, no exceptions** — including "one-time" init-code barriers.
   Barrier stage/access pairs are generated from a logical-resource-state →
   barrier-value lookup table; they are never hand-assembled at call sites
   (hand-assembled pairs are how spec violations like `TOP_OF_PIPE` + nonzero
   access mask propagated by copy-paste in Mini-Engine).

4. **Transient and persistent resources are distinct kinds from day one.**
   Ping-pong/history resources (e.g. TAA) do not fit a "reset every frame"
   model — the render graph's resource model must represent both kinds
   natively, not retrofit persistence as a workaround later.

5. **The render graph is backend-agnostic from day one.** It is designed once
   against both Vulkan and WebGPU, not built Vulkan-first with a second,
   hand-rolled integration strategy invented for WebGPU per feature.

## Consequences

- `engine/src/core/` (render graph + resource-state tracking) is a mandatory
  entry point for every rendering feature, not an optional layer — no RHI
  backend or higher-level system may issue a barrier/transition outside it.
- The WebGPU backend must expose equivalent resource-transition hooks into
  the graph even though WebGPU's own barrier model is implicit — the graph's
  abstraction, not either backend's native model, is the source of truth.
- Every future PR that adds a new GPU resource type must plug it into the
  logical-resource-state → barrier-value table rather than writing a barrier
  inline, even for "just this once" init code.
- The C++20 floor allows Concepts for RHI backend contracts and rules out
  reaching for C++17-only idioms anywhere in `engine/`.

## Alternatives Considered

- **Per-call-site hand-written barriers.** Rejected — this is the dominant
  incident source identified across Mini-Engine's changelog history
  (`CLAUDE.md` §8).
- **C++17.** Rejected — no existing engine code constrains us to it, the
  current PRD and `CLAUDE.md` both already specify C++20, and RHI backend
  contracts are planned around C++20 concepts.
- **Vulkan-first render graph, WebGPU integrated later.** Rejected — Mini-
  Engine already paid this cost once (a second hand-rolled integration
  strategy per feature); building the abstraction backend-agnostic from the
  start is cheaper than retrofitting it.
