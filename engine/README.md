# engine

OmniMed3D-Engine: a from-scratch C++20 rendering core with a dual-backend
RHI (Render Hardware Interface) — Vulkan (native) and WebGPU (browser, via
Emscripten) — built to render volumetric CT/MR data plus an AI
segmentation-mask overlay entirely client-side, no server-side GPU
inference. Product requirements: [`docs/prd/PRD.md`](../docs/prd/PRD.md)
§5.1 (Rendering), §5.3/§5.3.1 (REQ-C01, the mask-data contract this
engine honors), and Appendix A.

**Status:** the WASM/WebGPU path is where real rendering work has
landed — `wasm_smoke.js`/`.wasm` is the production rendering module
[`viewer/`](../viewer/README.md)'s Shell loads (`viewer/scripts/sync-engine-wasm.mjs`),
not a demo target. No native Vulkan `Device` implementation exists yet;
the native build currently exercises `core`/`concurrency`/`utils` and
their tests only. See [`docs/RENDERING_SPEC.md`](docs/RENDERING_SPEC.md)
for exactly what's currently rendered and tunable.

## Layout

```text
src/
  core/            RenderGraph — the single owner of all resource-state
                    transitions (no hand-written barriers elsewhere)
  concurrency/      frame barrier / thread pool primitives
  rhi/
    include/rhi/    Device.hpp — the backend-agnostic interface
    backends/
      vulkan/       not implemented yet
      webgpu/       the real, shipping rendering backend (WebGPUDevice)
  scene/ rendering/ assets/   scaffolded, not built out yet
  utils/            FrameStats and other small shared helpers

shaders/
  src/              Slang shader source (ADR-0002), one source cross-
                    compiled to both SPIR-V and WGSL at build time
  generated/        build output (SPIR-V / WGSL), gitignored

tools/codegen/       scaffolded (C++ struct <-> shader binding generator), empty

tests/
  parity/           scaffolded — cross-backend (Vulkan vs WebGPU) output
                    diff tests, blocked on a native Vulkan Device
  wasm_smoke/        shell.html, the WASM test harness page
  fixtures/          small binary fixtures (e.g. CT_small.dcm)

docs/
  RENDERING_SPEC.md  living spec of exactly what's rendered and tunable
  adr/               engine-only architectural decisions (git-tracked,
                    scoped to this module — see repo-root docs/adr/ for
                    cross-team decisions instead)
```

[`dicom-parser/`](../dicom-parser/README.md) is a sibling top-level
module, not nested under `engine/` — a shared C++20 DICOM parsing
library pulled into this build via `add_subdirectory()`, compiled once
and reused by both this engine's native dev/test tooling and the
browser Parse Worker's WASM build. See its own README and
`docs/adr/0004-shared-dicom-parser.md` for why it's one library rather
than two independent parsers.

## Build

**Native (Vulkan target, Windows/macOS):**

```sh
cd engine
cmake --preset windows-default   # or macos-default
cmake --build build
ctest --test-dir build
```

**WASM (WebGPU/Emscripten):**

```sh
# One-time per machine:
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk.bat install 4.0.10 && ./emsdk.bat activate 4.0.10

# Every build, from engine/:
./scripts/emsdk-shell.ps1 "cmake --preset wasm-windows" -EmsdkDir C:\dev\emsdk   # or emsdk-shell.sh / wasm-macos
./scripts/emsdk-shell.ps1 "cmake --build build_wasm" -EmsdkDir C:\dev\emsdk
```

Uses NMake Makefiles (not Ninja — Ninja can't invoke the `.bat`-wrapped
`em++`/`emar` on Windows) via `cmake/EmscriptenToolchain.cmake`. Artifacts
land in `build_wasm/` (gitignored); `wasm_smoke.js`/`.wasm` are what
`viewer`'s `sync-engine-wasm` script copies into the Shell's servable
path.

**Shader toolchain (`slangc`):** a host build tool, resolved via
`find_program` against `$VCPKG_ROOT`'s classic (non-manifest) install
(`vcpkg install shader-slang`) or a prebuilt release on `PATH` — see
`shaders/CMakeLists.txt`. Runs unconditionally as part of both the
native and WASM configure steps.

Both presets are defined in `CMakePresets.json`; native uses vcpkg
manifest mode (`vcpkg.json`) via `$VCPKG_ROOT`, WASM does not (WASM-only
dependencies, e.g. `glm`, come from `FetchContent` instead — see
`src/rhi/backends/webgpu/CMakeLists.txt`).

Never trust a build's exit code alone for the WASM path — `.bat`-wrapped
toolchains can report success while producing nothing; check
`build_wasm/wasm_smoke.wasm`'s timestamp actually moved.

## Testing

- `ctest --test-dir build` — native unit tests (`core`'s `RenderGraph`
  tests today).
- `tests/parity/` — scoped to cross-backend (Vulkan vs. WebGPU) parity
  once a native Vulkan `Device` exists; currently scaffolded only.
- Cross-backend integration and visual regression is currently covered
  from the other side, in [`viewer/tests/e2e/`](../viewer/README.md#browser-e2e-tests-testse2e)
  (real browser, real WASM build, real WebGPU adapter).

## Documentation

- [`docs/RENDERING_SPEC.md`](docs/RENDERING_SPEC.md) — the living spec:
  exactly what the engine renders today and what's tunable, plus a
  change log of how it got there.
- [`docs/adr/`](docs/adr/) — engine-internal architectural decisions
  (rendering model + C++ standard, shader source strategy, CI/build
  environment, the shared DICOM parser split). Cross-team decisions
  (e.g. the REQ-C01 contract shape) live in the repo-root
  [`docs/adr/`](../docs/adr/) instead.
- Root [`README.md`](../README.md) — monorepo layout, architecture
  diagram, and getting-started paths for every module.
