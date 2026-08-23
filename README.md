# OmniMed3D

A browser-only, on-device medical 3D DICOM viewer: WebGPU volume
rendering plus AI organ/structure segmentation, where the entire
pipeline — DICOM parsing, preprocessing, AI inference, and rendering —
runs client-side. No file is ever uploaded to a server, and once the
static assets are loaded once, the app keeps working offline.

**Status: early-stage prototype, under active development.** This is
research/prototype software — it is not a certified clinical device, and
does not aim for clinical-grade diagnostic accuracy.

## Why

Most web-based DICOM viewers either depend on a server for parsing/AI
inference, or fall back to WebGL and hit a performance ceiling on real
volumetric data. OmniMed3D's core bet: WebGPU is capable enough to do
cinematic-quality volume rendering _and_ run AI segmentation, entirely
on-device, so the whole experience — installation-free, zero server
cost, complete data privacy — becomes viable for places that can't
support a traditional workstation or IT setup: small clinics, research
and teaching settings, telemedicine sessions, and mobile/ambulance
deployments with unstable or no network.

## Architecture at a glance

```mermaid
graph LR
    U["Local DICOM file(s)"] --> P["Parse Worker
(WASM, dicom-parser)"]
    P -->|HU volume| E["Engine
(WebGPU render)"]
    P -->|HU slices| I["Inference Worker
(ONNX Runtime Web)"]
    I -->|mask slices| E
    E --> V["3D view: volume renders
immediately, mask overlay
fills in progressively"]
```

Everything above runs in the browser. The only thing a server ever does
is host the static files (HTML/JS/WASM/models) — see
[`docs/prd/PRD.md`](docs/prd/PRD.md) for the full requirements and the
mask-data contract (REQ-C01) that lets the rendering and AI sides stay
decoupled.

## Monorepo layout

| Path                                          | What it is                                                                                                                                                                                                                                                  | Owner                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`engine/`](engine/)                          | The rendering core: a from-scratch C++20 engine with a Vulkan (native) + WebGPU/WASM (browser) RHI abstraction. Volume rendering, clinical window/level, the mask-overlay compositor. See [`engine/docs/RENDERING_SPEC.md`](engine/docs/RENDERING_SPEC.md). | `@nowead`                                           |
| [`viewer/`](viewer/README.md)                 | The web application shell wrapping the engine's WASM module, plus the Parse Worker (DICOM → Hounsfield Units) and Inference Worker (ONNX Runtime Web segmentation) it hosts. An npm workspace — see its own README for the full build/test setup.           | `@nowead` (Inference Worker subtree: `@hyuniverse`) |
| [`dicom-parser/`](dicom-parser/README.md)     | A shared C++20 DICOM parsing library, compiled to both a native target (engine dev/test tooling) and WASM (the Parse Worker) — one parser, not two independent implementations.                                                                             | `@nowead`                                           |
| [`ai-pipeline/`](ai-pipeline/)                | Offline model work: ONNX conversion, PTQ quantization, Dice/IoU accuracy verification. Produces the static `.onnx` files the Inference Worker loads — no runtime server involved.                                                                           | `@hyuniverse`                                       |
| [`test-data/`](test-data/lidc_idri/README.md) | Shared, real (de-identified) DICOM sample data, tracked via Git LFS.                                                                                                                                                                                        | `@nowead`                                           |
| `infra/`                                      |                                                                                                                                                                                                                                                             | `@hyuniverse`                                       |

See [`.github/CODEOWNERS`](.github/CODEOWNERS) for the exact review-routing rules.

## Getting started

Each module owns its own build; see its README for full detail. Quick pointers:

**Engine** (C++20, needs [vcpkg](https://vcpkg.io) and, for the browser build, [Emscripten](https://emscripten.org)):

```sh
cd engine
cmake --preset macos-default   # or windows-default
cmake --build build

# Browser (WebGPU/WASM) build:
./scripts/emsdk-shell.sh "cmake --preset wasm-macos" ~/emsdk    # or emsdk-shell.ps1 / wasm-windows on Windows
./scripts/emsdk-shell.sh "cmake --build build_wasm" ~/emsdk
```

**Viewer** (Vite + TypeScript, npm workspaces):

```sh
cd viewer
npm install
npm run dev      # dev server
npm run build    # production build
npm test         # unit tests (vitest, across all workspace packages)
```

The viewer's dev server expects the engine's WASM build to already exist
— see [`viewer/README.md`](viewer/README.md#building-and-testing) for
the `sync-engine-wasm`/`sync-demo-ct` steps that wire the two together.

**dicom-parser** — not configured standalone; it's pulled into the
engine's own build via `add_subdirectory()`. Building `engine/` above
also builds and tests it — see
[`dicom-parser/README.md`](dicom-parser/README.md#build--test) for the
native-only targets that come out of that build (`dicom_inspect`, its
test suite) and the `ctest` command to run them.

## Documentation

- [`docs/prd/PRD.md`](docs/prd/PRD.md) — product requirements, the source of truth for what this project needs to satisfy.
- [`engine/docs/RENDERING_SPEC.md`](engine/docs/RENDERING_SPEC.md) — a living spec of exactly what the engine renders and what's currently tunable.
- [`docs/adr/`](docs/adr/) and [`engine/docs/adr/`](engine/docs/adr/) — architectural decision records, cross-team and engine-internal respectively.
- [`docs/verification/`](docs/verification/) — empirical verification reports (accuracy, latency, integration).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch naming, commit
message conventions, coding standards, and the PR process — and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Third-party software,
model, and dataset attributions are tracked in [`NOTICE.md`](NOTICE.md).
