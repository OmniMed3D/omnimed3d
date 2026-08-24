# ADR-0003: CI / build environment strategy

| Field  | Value                                                    |
| ------ | --------------------------------------------------------- |
| Status | Partially resolved 2026-08-24 (WASM/WebGPU CI build — see below); native Vulkan/Docker question below remains deferred |
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

**WASM/WebGPU CI build (2026-08-24, resolved):** `.github/workflows/test.yml`'s
`e2e-viewer` job builds the Engine's WASM module directly on a
GitHub-hosted `macos-latest` runner -- emsdk (pinned `4.0.10`, matching
`CLAUDE.md` §7's local instructions) and `slangc` (pinned `v2026.16`,
see ADR-0002) are both installed directly on the runner (git-clone +
`emsdk install`/`activate` for the former, a direct GitHub-release
download for the latter), not via the `emscripten/emsdk` Docker image
this ADR's own analysis favored. Reasons this diverged from that
analysis: (1) the target here is WebGPU e2e tests, which need real
GPU/Metal access on a macOS runner -- Docker containers on
GitHub-hosted macOS runners have much more limited support than on
Linux runners, and this project's own local macOS WASM build already
uses direct emsdk installation (`engine/scripts/emsdk-shell.sh`), not
Docker, so the CI job mirrors that rather than introducing a second,
divergent toolchain-provisioning strategy; (2) `emsdk install`/`activate`
plus a `slangc` download are each simple, scriptable, and now verified
end-to-end (rebuilt from a fully clean `build_wasm/` with a freshly
installed emsdk and freshly downloaded `slangc`, matching a real CI
checkout, before this was committed) -- the Docker image's main
advantage (toolchain reproducibility) isn't a gap either approach
leaves open. This decision is scoped narrowly to *this* job's WASM
build; it does not settle the native Vulkan/`tests/parity/`
Linux-runner question below, which stays deferred.

**Native Vulkan / `tests/parity/` CI (still deferred):** None yet.
Revisit once that work actually starts, and open it as its own proposal
in the repo-root `docs/adr/`, with `ai-pipeline`/`infra` (@hyuniverse) in
the loop since a Docker-based Linux CI strategy (lavapipe software
Vulkan, per the analysis above) would affect shared CI, not just
`engine/`.
