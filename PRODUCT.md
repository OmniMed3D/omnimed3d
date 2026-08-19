# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + vanilla TypeScript (no UI framework), npm workspaces rooted at `viewer/`. Pre-existing repo decision (PRD §6.1), not made during this init — recorded here as evidence, not a new choice.

## Users

Five target segments (PRD §2.2), treated as parallel — the PRD does not rank them by priority:

- **Small clinic & health center clinicians** — need 3D image analysis without an expensive workstation or IT setup/maintenance staff.
- **Medical imaging researchers & students** — need a highly accessible viewer for research and education.
- **Telemedicine practitioners** — need image sharing and analysis inside collaborative diagnostic sessions.
- **Users in software-restricted environments** — need a web tool usable without install permissions.
- **Emergency medical services & mobile clinics** — need a fully offline-capable viewer for unstable/disconnected networks.

Common thread across all five: install-free, zero-IT-setup, resource- and infrastructure-constrained settings.

## Product Purpose

A browser-only, on-device medical 3D DICOM viewer: WebGPU volume rendering plus on-device AI organ/structure segmentation, where the entire pipeline (DICOM parsing → preprocessing → AI inference → rendering) runs client-side. Original DICOM data is never uploaded. Explicitly prototype/research-stage software (PRD §3.2 non-goals) — not seeking clinical-grade diagnostic accuracy or regulatory certification (FDA/CE-MDR).

## Positioning

No comparable install-free, zero-server, offline-capable browser tool combines WebGPU cinematic-quality volume rendering with on-device AI segmentation at this accessibility point. The PRD's own comparison class is existing WebGL-based viewers (e.g. Cornerstone3D, its named P0 benchmark target, §4) — not other server/cloud-AI-dependent viewers.

## Operating Context

- **Primary workflow:** select local DICOM file(s)/folder in Chrome → volume renders immediately → AI segmentation mask overlays progressively as it completes (never blocks the initial render) → user manipulates the 3D view (orbit rotate, zoom, slice pan, window/level) and inspects the result.
- **Deployment:** static file hosting only, zero server infrastructure; offline-capable after the first asset load (NFR-06).
- **Real operating environments** named in the PRD: small clinics/health centers without IT staff, research/education settings, telemedicine sessions, installation-restricted environments, ambulances and mobile clinics with unstable or no network.
- **Target browser:** Google Chrome Desktop + Mobile (P0, REQ-R07). Firefox/Desktop Safari is P1 (REQ-R11), not yet in scope.
- **Operative usability bar (PRD §9):** a non-developer completes load → rotate → zoom → slice-pan within 3 unassisted attempts. This success criterion, not a formal accessibility standard, is what "intuitive" (REQ-R06) is measured against.

## Capabilities and Constraints

- **Confirmed P0 rendering capabilities:** WebGPU DICOM volume rendering (REQ-R01), axial cross-sections (REQ-R02), baseline colormap/transfer-function LUT presets (REQ-R03), resolution/quality adjustment (REQ-R04), hybrid AI-mask overlay compositing (REQ-R05), intuitive web UI shell (REQ-R06).
- **Mask overlay contract (REQ-C01, §5.3.1):** `uint8` class-index texture, always at the original volume's resolution, delivered progressively slice-by-slice; stale-`volumeId` slices are discarded; unfilled voxels read as background.
- **Currently implemented UI shell** (issue #34): local file/folder picker, mouse-driven orbit camera (rotate + wheel zoom), window/level sliders plus 4 clinical presets.
- **Confirmed gap, in scope for this round of design/build work:** slice panning (2D axial scroll) — PRD §9 names it as one of three required interactions (with rotation and zoom) for the 3-attempt success bar, but it does not exist in the shipped UI yet.
- **Explicit non-goals** (§3.2, permanent): clinical-grade diagnostic accuracy, PACS/cloud integration, FDA/CE-MDR certification, multi-channel (>RGB) rendering.
- **Explicit out-of-scope-for-now** (§7.2, revisitable): display calibration/strict DICOM color pipeline compliance, advanced pathology quantification, multi-class segmentation, chunked multi-GB streaming parsing, measurement/annotation/collaboration tools (REQ-R09/R10, P2).
- **Terminology:** "volume" = the loaded CT/MR 3D dataset; "mask"/"overlay" = the AI segmentation result composited on the volume; "window/level" = the clinical HU windowing controls (center/width); "Parse Worker" / "Inference Worker" / "Shell" = the three-part pipeline architecture (this UI *is* the Shell).

## Brand Commitments

Product name: **OmniMed3D**. No logo, color identity, or other visual brand asset exists yet — nothing beyond the name is binding.

## Evidence on Hand

- Real (non-synthetic) DICOM sample: `engine/tests/fixtures/CT_small.dcm`, already used in e2e verification.
- Dummy plumbing-only ONNX segmentation model: `viewer/tests/fixtures/dummy-lungmask.onnx` (190 bytes) — a static concat/argmax graph that always yields background; not representative of real segmentation output or quality.
- No real trained lungmask model, no multi-vendor DICOM sample set, and no clinical screenshots/testimonials/case studies exist yet — future work must not fabricate these.
- Existing, verified UI surface: `viewer/src/shell/` (file picker, camera controls, window/level panel) — screenshot-diff verified via Playwright (`viewer/tests/e2e/shell-mask-integration.spec.ts`) and manually confirmed in a real browser by the project owner.

## Product Principles

1. **Zero-install, zero-server, browser-only.** Every workflow step (parse, infer, render) completes on-device; nothing in the UI should imply or require a network dependency.
2. **Rendering is never blocked by inference.** The UI must always show the volume rendering immediately, with the mask overlay filling in progressively and visibly as a secondary, non-blocking layer.
3. **Learnable without training.** A non-developer must reach a working result (load → rotate → zoom → slice-pan) within 3 unassisted attempts; prefer obvious, self-explanatory controls over powerful-but-hidden ones.
4. **Built for constrained, real-world conditions.** Low-spec hardware, mobile touch, unstable/offline networks, and non-ideal ambient environments (ambulance, mobile clinic) are the baseline, not an edge case.
5. **Prototype-honest.** This is research/prototype software, not a certified clinical device; the UI should not visually overclaim a clinical-grade authority it hasn't earned.

## Accessibility & Inclusion

Clinical/mobile-environment usability needs (confirmed via this init's interview; no formal standard such as WCAG is cited anywhere in the PRD):

- Legible and operable under variable or bright ambient lighting (mobile clinics, ambulances — not a controlled reading room).
- Touch targets sized for quick, possibly gloved-hand operation on mobile Chrome (REQ-R07 includes Mobile Chrome at P0).
- Minimal-training operability: the PRD's own success bar (§9) — a non-developer completing load + rotate + zoom + slice-pan within 3 unassisted attempts — is the working acceptance test until a formal standard is adopted.
