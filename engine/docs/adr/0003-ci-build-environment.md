# ADR-0003: CI / build environment strategy

| Field  | Value                                                    |
| ------ | --------------------------------------------------------- |
| Status | Deferred — not a real decision yet, placeholder only       |
| Date   | 2026-08-11                                                 |

## Context

While scoping the `engine/CMakeLists.txt` skeleton, the question came up of
which compiler/toolchain the native build should target. The user correctly
pushed back that this isn't a decision to make in isolation inside
`engine/`: it depends on where CI eventually builds this project (what
Docker container OS, what services it prepares), which also touches
`ai-pipeline/`/`infra/` (@hyuniverse's modules per `.github/CODEOWNERS`) —
a cross-team concern, not an engine-only one.

This file exists so that analysis isn't lost, **not** to record an actual
accepted decision — `infra/` and any CI build pipeline don't exist yet
(only `.github/workflows/conventions.yml`, a commit/branch-name lint), so
there is nothing concrete to accept or reject against. Once `infra/`/CI
exist, this should become a real proposal in the repo-root `docs/adr/`
(cross-team, per the ADR split in `claude.md` §6) — not stay here.

## Analysis so far (non-binding)

- Per PRD §6.2/NFR-06, Docker has exactly one real **runtime** role in this
  architecture: the optional PACS backend adapter (Orthanc + FastAPI +
  Nginx, REQ-A07, P2, non-MVP). The core product (`engine/` + `viewer/` +
  client-side AI inference) ships as static files consumed entirely
  client-side — it is never itself "run in a container."
- `engine/`'s only real contact with Docker is **CI reproducibility**, not
  runtime:
  - WASM builds: pinning an exact Emscripten SDK version is notoriously
    fiddly to script fresh on every CI run. The official `emscripten/emsdk`
    Docker image is the common, low-risk way to get a reproducible
    Emscripten toolchain in CI.
  - Native Vulkan builds (for `tests/parity/`): GitHub-hosted runners have
    no real GPU, so headless testing needs a software Vulkan implementation
    (e.g. lavapipe). This is more commonly done on Linux runners than
    Windows ones, and `Mini-Engine-reference/CMakePresets.json` already has
    a `linux-default` preset (clang-18) suggesting this exact question was
    faced there before.
- This does **not** block local Windows development: this project's own
  compiler choice is already per-platform, not global —
  `Mini-Engine-reference/CMakePresets.json` configures a different compiler
  per preset (mac: homebrew clang, Windows: standalone LLVM clang, Linux:
  clang-18, WASM: emcc via the Emscripten toolchain file). The Windows-local
  preset in `engine/CMakePresets.json` can be decided independently of
  whatever CI/Docker strategy is eventually chosen.

## Decision

None yet. Revisit once `infra/`/CI exist and open this as a proposal in the
repo-root `docs/adr/`, with `ai-pipeline`/`infra` (@hyuniverse) in the loop
since it affects shared CI, not just `engine/`.
