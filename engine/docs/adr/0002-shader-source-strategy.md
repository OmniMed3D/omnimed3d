# ADR-0002: Shader source strategy

| Field  | Value                                                        |
| ------ | ------------------------------------------------------------ |
| Status | Proposed — not yet Accepted, decision deferred to a dedicated session |
| Date   | 2026-08-10                                                    |

## Context

`CLAUDE.md` §8 identifies cross-backend shader drift as **the single largest
structural risk** carried forward from Mini-Engine: hand-maintaining parallel
GLSL (Vulkan) and WGSL (WebGPU) let not just layout but *logic* — culling
rules, dummy-texture conventions — drift silently, correct on one backend and
wrong on the other for months before discovery.

`docs/current/OMNIMED3D_NEW_ENGINE_DRAFT_2026-08-03.md` §3 names this as
ADR-0002 and flags it as the decision the rest of the architecture depends on
most, ahead of resource-ownership and concurrency ADRs.

This ADR must be resolved — Accepted or explicitly revised — **before the
first shader-facing struct is written** (`CLAUDE.md` §8). It is intentionally
left Proposed here because adopting Option A introduces a new build-time
external dependency, and `CLAUDE.md` §4 requires explicit user consent before
installing any new dependency, package, or library — that consent
conversation belongs in a dedicated follow-up session, not bundled into this
scaffolding pass.

## Decision

**Not yet decided.** Two options were identified; a recommendation is
recorded below for the follow-up session to confirm or override.

### Option A — Shared shading language + cross-compilation

Single shader source (e.g. Slang) cross-compiled to SPIR-V (Vulkan) and WGSL
(WebGPU) via a build-time toolchain (e.g. `slangc`).

- Eliminates logic drift at the source: there is only one copy of any given
  shader's logic.
- Requires adding a new external toolchain dependency to the build —
  needs explicit user sign-off per `CLAUDE.md` §4, plus CMake integration
  work (`LINK_DEPENDS`-style explicit build dependency registration per
  `CLAUDE.md` §8 "Build / verification").

### Option B — Hand-maintained GLSL + WGSL, codegen for shared structs only

Shaders themselves stay hand-written per backend; `engine/tools/codegen/`
generates only the shared structs/constants (bindings, UBO layouts) common to
both.

- Closes the *layout*-drift failure mode (the RHI-abstraction-leak item in
  `CLAUDE.md` §8: "UBO-related sizes scattered across 4 places will
  eventually disagree in one").
- Does **not** close the *logic*-drift failure mode — the actual pattern
  Mini-Engine hit (culling rules, dummy-texture conventions diverging) — since
  the shader bodies themselves are still two independently hand-edited files.
- No new external dependency; ships with tooling already scoped for this repo
  (`tools/codegen/`, `CLAUDE.md` §6).

## Consequences (if Option A is later accepted)

- `engine/shaders/src/` holds Slang source; `engine/shaders/generated/`
  (already `.gitignore`d as a build artifact directory, see this session's
  `.gitignore` change) holds the compiled SPIR-V/WGSL output per backend.
- CMake must register the shader compile step as an explicit build dependency
  so a relink is forced on shader-source change (`CLAUDE.md` §8, §9 "No host
  filesystem on WASM" — the WASM path additionally needs `--preload-file` +
  `LINK_DEPENDS` for the compiled output).
- The `slangc` toolchain dependency needs a documented install path in the
  (not-yet-written) `engine/CMakeLists.txt` / `CLAUDE.md` §7 build commands
  section.

## Alternatives Considered

- **Option B as the final answer, not a fallback.** Rejected as the
  recommendation (see below) — `CLAUDE.md` §8 frames parallel hand
  maintenance as "the failure mode to avoid, not a fallback to keep on the
  table," and Option B's codegen only covers layout, not the logic-drift
  failures Mini-Engine actually documented.

## Recommendation (non-binding until Accepted)

Option A (Slang cross-compilation), because it is the only option of the two
that closes the actual failure mode this ADR exists to prevent (logic drift,
not just layout drift). This is a recommendation for the follow-up session
that will also carry the explicit-dependency-consent conversation required by
`CLAUDE.md` §4 — it does not by itself change this ADR's status to Accepted.
