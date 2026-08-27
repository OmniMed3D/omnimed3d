# OmniMed3D

A browser-only, on-device medical 3D DICOM viewer: WebGPU volume
rendering plus AI organ/structure segmentation, where the entire
pipeline — DICOM parsing, preprocessing, AI inference, and rendering —
runs client-side. No file is ever uploaded to a server, and once the
static assets are loaded once, the app keeps working offline.

**Status: early-stage prototype, under active development.** This is
research/prototype software — it is not a certified clinical device, and
does not aim for clinical-grade diagnostic accuracy.

## Demo

Screen captures from Chrome — everything below is running client-side,
no server involved.

**WebGPU volume rendering** — real-time raymarch of a CT volume with
clinical window/level and cinematic lighting:

https://github.com/user-attachments/assets/5ac43295-b217-4cd2-8f95-6d7688953cbb

**On-device AI segmentation** — the lung mask (ONNX Runtime Web) fills
in progressively over the rendered volume:

https://github.com/user-attachments/assets/b214d844-690f-496f-94dc-a1f61ac8dc84

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

## Current scope & limitations

- **AI segmentation is lung-only.** The shipped model is `lungmask`
  (R231, Apache-2.0) — a single-organ model (PRD REQ-A01). Multi-organ /
  multi-class segmentation is a tracked future goal, not available
  today.
- **iOS and desktop Safari: AI inference is not practically usable.** A
  WebKit-specific bug in ONNX Runtime Web's WebGPU backend causes
  unbounded memory growth and crashes on real devices (see
  `viewer/src/workers/inference-worker/docs/adr/0003-webkit-routing.md`),
  so those browsers are routed to a WASM+INT8-only fallback with no GPU
  acceleration — measured at ~2.3s/slice, versus this project's
  <500ms/slice target elsewhere. Volume rendering and viewing work
  normally on iOS/Safari; only AI segmentation is affected.
- **Fully-supported browser target: Google Chrome** (Desktop + Mobile,
  PRD REQ-R07). Other Chromium browsers and Android generally work the
  same way; Firefox and desktop Safari are not yet supported (see
  Roadmap below).

### Roadmap (not implemented yet)

Tracked in [`docs/prd/PRD.md`](docs/prd/PRD.md) as P1/P2 requirements or
deferred-but-revisitable scope (§7.2) — listed here for visibility, not
a committed schedule:

- Multi-class / multi-organ segmentation (REQ-A14), and a second model
  architecture (e.g. spleen) as an architecture-reuse proof point.
- Firefox and desktop Safari support (REQ-R11).
- Measurement tools (distance/angle/volume) and collaboration tools
  (snapshot export, annotations) — REQ-R09/R10.
- An optional backend adapter (Orthanc + FastAPI) for PACS
  integration/batch processing in enterprise environments — REQ-A07/A12.
  Explicitly optional; the core product stays Pure On-Device.
- Chunked streaming parsing for multi-gigabyte DICOM series.
- Automated hardware fallback across WebNN → WebGPU → WASM (REQ-C02) —
  WebGPU/WASM only today.

## Monorepo layout

| Path | What it is | Owner |
| --- | --- | --- |
| [`engine/`](engine/README.md) | The rendering core: a from-scratch C++20 engine with a Vulkan (native) + WebGPU/WASM (browser) RHI abstraction. Volume rendering, clinical window/level, the mask-overlay compositor. See [`engine/docs/RENDERING_SPEC.md`](engine/docs/RENDERING_SPEC.md). | `@nowead` |
| [`viewer/`](viewer/README.md) | The web application shell wrapping the engine's WASM module, plus the Parse Worker (DICOM → Hounsfield Units) and [Inference Worker](viewer/src/workers/inference-worker/README.md) (ONNX Runtime Web segmentation) it hosts. An npm workspace — see its own README for the full build/test setup. | `@nowead` (Inference Worker subtree: `@hyuniverse`) |
| [`dicom-parser/`](dicom-parser/README.md) | A shared C++20 DICOM parsing library, compiled to both a native target (engine dev/test tooling) and WASM (the Parse Worker) — one parser, not two independent implementations. | `@nowead` |
| [`ai-pipeline/`](ai-pipeline/README.md) | Offline model work: [ONNX conversion](ai-pipeline/conversion/README.md), [PTQ quantization](ai-pipeline/quantization/README.md), Dice/IoU accuracy verification. Produces the static `.onnx` files the Inference Worker loads — no runtime server involved. | `@hyuniverse` |
| [`test-data/`](test-data/lidc_idri/README.md) | Shared, real (de-identified) DICOM sample data, tracked via Git LFS. | `@nowead` |
| `infra/` | | `@hyuniverse` |

See [`.github/CODEOWNERS`](.github/CODEOWNERS) for the exact review-routing rules.

## Getting started

Each module owns its own build; see its README for full detail. This
section is the from-a-fresh-clone path.

### Prerequisites (one-time per machine)

On `PATH`: Git, [Git LFS](https://git-lfs.com), [CMake](https://cmake.org),
[Ninja](https://ninja-build.org), a standalone
[LLVM/Clang](https://github.com/llvm/llvm-project/releases), and
[Node.js](https://nodejs.org). On Windows, the browser (WASM) build also
needs [Visual Studio 2022](https://visualstudio.microsoft.com/downloads/)
or the [Build Tools for Visual Studio 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the "Desktop development with C++" (MSVC) workload — its
`wasm-windows` preset builds with NMake, and the build scripts locate
`nmake.exe` under the VS 2022 install (default install location; no
Developer Command Prompt or `vcvars` needed).

The layout below keeps `vcpkg` and `emsdk` as siblings of the repo, in
whatever folder you keep projects in:

```text
<your projects folder>/
├─ omnimed3d/   ← this repo (cloned in the next step)
├─ vcpkg/
└─ emsdk/
```

Run this **from that projects folder** — pick the block for your shell.

**Windows (PowerShell)** — the primary host:

```powershell
git lfs install

git clone https://github.com/microsoft/vcpkg
.\vcpkg\bootstrap-vcpkg.bat
.\vcpkg\vcpkg install shader-slang    # required — both engine builds need slangc

git clone https://github.com/emscripten-core/emsdk.git emsdk
cd emsdk; .\emsdk.bat install 4.0.10; .\emsdk.bat activate 4.0.10; cd ..

# Persist both so new shells and the build scripts find them
# (add them to your User environment variables too):
$env:VCPKG_ROOT = "$PWD\vcpkg"
$env:EMSDK      = "$PWD\emsdk"
```

**macOS / Linux (bash or zsh):**

```bash
git lfs install

git clone https://github.com/microsoft/vcpkg
./vcpkg/bootstrap-vcpkg.sh
./vcpkg/vcpkg install shader-slang    # required — both engine builds need slangc

git clone https://github.com/emscripten-core/emsdk.git emsdk
cd emsdk && ./emsdk install 4.0.10 && ./emsdk activate 4.0.10 && cd ..

# Persist both (add to ~/.zshrc or ~/.bashrc) so new shells and the
# build scripts find them:
export VCPKG_ROOT="$PWD/vcpkg"
export EMSDK="$PWD/emsdk"
```

### Clone

```sh
git clone <repo-url> omnimed3d   # into the projects folder, next to vcpkg/ and emsdk/
cd omnimed3d
git lfs pull   # test-data/ DICOM — without git-lfs you get pointer files, not real data
```

### Fastest path for local iteration

After a one-time `npm install` in `viewer/`, one command rebuilds the
engine's WASM target, syncs it into the viewer, and starts the dev server:

```sh
cd viewer
npm install            # one-time
npm run sync-demo-ct   # one-time, or when the demo DICOM data changes
npm run dev:full       # Windows
npm run dev:full:mac   # macOS/Linux
```

`dev:full` chains the WASM build → `sync-engine-wasm` → a backgrounded dev
server (also managed by `dev:start`/`dev:stop`/`dev:status`). See
[`viewer/README.md`](viewer/README.md#building-and-testing) for the steps
run individually.

### Per-module builds

**Engine** (C++20 — needs vcpkg + `VCPKG_ROOT` and, for the browser
build, Emscripten; see Prerequisites):

```sh
cd engine
cmake --preset windows-default   # or macos-default
cmake --build build
ctest --test-dir build

# Browser (WebGPU/WASM) build — configure + build in one emsdk activation:
./scripts/wasm-build.ps1   # Windows
./scripts/wasm-build.sh    # macOS/Linux
```

Artifacts land in `engine/build_wasm/`.

**Viewer** (Vite + TypeScript, npm workspaces):

```sh
cd viewer
npm install
npm run sync-engine-wasm   # copy engine/build_wasm/* into src/shell/public/engine/ (needs the WASM build above)
npm run sync-demo-ct       # copy test-data/* into src/shell/public/demo-ct/ (needs git lfs pull)
npm run dev                # dev server (foreground); npm run dev:start backgrounds it
npm run build              # production build
npm test                   # unit tests (vitest, across all workspace packages)
```

The dev server expects the engine's WASM build to already exist — the
`sync-engine-wasm` step above wires the two together.

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
