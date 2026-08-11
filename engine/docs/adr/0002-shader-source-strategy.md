# ADR-0002: Shader source strategy

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-10 |

## Context

`CLAUDE.md` §8 identifies cross-backend shader drift as **the single largest
structural risk** carried forward from Mini-Engine: hand-maintaining parallel
GLSL (Vulkan) and WGSL (WebGPU) let not just layout but *logic* — culling
rules, dummy-texture conventions — drift silently, correct on one backend and
wrong on the other for months before discovery.

`docs/current/OMNIMED3D_NEW_ENGINE_DRAFT_2026-08-03.md` §3 names this as
ADR-0002 and flags it as the decision the rest of the architecture depends on
most, ahead of resource-ownership and concurrency ADRs.

This ADR was left Proposed after the initial engine scaffolding pass because
Option A introduces a new build-time external dependency, and `CLAUDE.md` §4
requires explicit user consent before installing any new dependency, package,
or library. That consent was given in a dedicated follow-up decision on
2026-08-10 (see Decision below), so this ADR is now Accepted.

## Decision

**Option A — shared shading language + cross-compilation (Slang).** Shader
source is written once in Slang and cross-compiled at build time to SPIR-V
(Vulkan) and WGSL (WebGPU) via the `slangc` toolchain.

This was weighed against Option B (hand-maintained GLSL + WGSL, with
`engine/tools/codegen/` generating only shared structs/constants) — see
Alternatives Considered. Option A was chosen because it is the only one of
the two that closes the actual failure mode this ADR exists to prevent:
logic drift (culling rules, dummy-texture conventions), not just layout
drift. Adding `slangc` as a new build-time toolchain dependency is accepted
as the cost of closing that failure mode, per the explicit consent given for
this decision (`CLAUDE.md` §4).

## Consequences

- `engine/shaders/src/` holds Slang source; `engine/shaders/generated/`
  (already `.gitignore`d as a build artifact directory) holds the compiled
  SPIR-V/WGSL output per backend.
- CMake must register the shader compile step as an explicit build
  dependency so a relink is forced on shader-source change (`CLAUDE.md` §8
  "Build / verification", §9 "No host filesystem on WASM" — the WASM path
  additionally needs `--preload-file` + `LINK_DEPENDS` for the compiled
  output).
- The `slangc` toolchain needs a documented install path and version pin,
  recorded in `CLAUDE.md` §7 (build commands) once `engine/CMakeLists.txt`
  exists — that CMake/build skeleton work is the next engine-core task this
  ADR unblocks.
- Every future shader-facing struct (UBO layouts, push constants, vertex
  inputs) is written once in Slang, not duplicated per backend — the
  RHI-abstraction-leak pattern in `CLAUDE.md` §8 ("UBO-related sizes
  scattered across 4 places") is closed at the source level, not just via a
  struct-codegen layer bolted on top of two hand-written shader files.

## Alternatives Considered

- **Option B — hand-maintained GLSL + WGSL, codegen for shared structs
  only.** `engine/tools/codegen/` would generate only the shared
  structs/constants (bindings, UBO layouts) common to both backends, while
  shader bodies stay hand-written per backend. Rejected: it closes the
  *layout*-drift failure mode but not the *logic*-drift failure mode Mini-
  Engine actually documented (culling rules, dummy-texture conventions
  diverging silently between backends) — `CLAUDE.md` §8 frames parallel hand
  maintenance as "the failure mode to avoid, not a fallback to keep on the
  table." Its one advantage — no new external dependency — was judged not to
  outweigh leaving the primary risk this ADR exists to close unaddressed.
