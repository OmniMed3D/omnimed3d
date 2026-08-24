# Rendering Spec

| Field | Value |
| --- | --- |
| Status | Living document (git-tracked) — every time a rendering-related branch merges, update "1. Current Spec" to reflect the new state and append an entry to "2. Change History" |
| Written | 2026-08-20 |
| Purpose | (1) Give one place to see exactly what the engine renders and what's currently tunable, and (2) keep a record of why/when each change landed. Originated from `docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md`'s proposals (that analysis doc has since been deleted, 2026-08-21 — superseded now that its proposals are either implemented here or carried into `docs/current/ENGINE_ROADMAP_2026-08-21.md`'s backlog); this document reflects only what was actually implemented and merged. |

---

## 1. Current Spec

### 1.1 View mode

`engine_set_view_mode(mode)` — `0 = Orbit3D` (default), `1 = AxialSlice2D`. Each uses a distinct shader/pipeline and its own UBO struct (`RaymarchUBO` vs `AxialSliceUBO`, see §1.5).

### 1.2 3D Orbit volume rendering (`volume_raymarch.slang`)

Front-to-back raymarch through an R16Float HU 3D texture. The ray's traversal range (`tNear`/`tFar`) is computed against the **clip box** (§1.4a), not the volume's full AABB — texture sampling coordinates (`uvw`) stay anchored to the full AABB regardless, so clipping only shortens/moves the visible range without touching how the volume or mask textures are sampled. Per step:

1. **Window/level normalization** — clamps raw HU into `[0,1]` as `n`, using `windowCenter`/`windowWidth`. (`engine_set_window_level`, `engine_set_colormap_preset`)
2. **Pre-integrated transfer-function lookup** — samples a 256×256 2D LUT (binding 5) at `(frontN, backN)` to get this step segment's average color (`colorBar`) and average classification value (`sBar`). Compared to a single-point classification, this reduces thin high-contrast structures being missed between steps at low quality tiers (fewer/coarser steps). When `sf==sb` (consecutive steps' `n` values are nearly equal) it converges to the original single-point classification exactly. `sBar` is then scaled by `densityScale` (§1.4a, default `1.0` — no change) before it reaches absorption.
3. **Gradient read** — reads the precomputed gradient volume (binding 6, `gradient_bake.slang`, baked once per `loadVolume()` rather than sampled per raymarch step, issue #81's own follow-up) trilinearly at this step's `uvw`, then divides by `windowWidth` to convert the stored raw-HU-per-mm value into the same window-normalized-per-mm units the old runtime-computed gradient produced (windowed density `n = (raw-center)/width` is an affine rescaling of raw HU, so its gradient is exactly the raw gradient over `windowWidth`) — this is what keeps `gradientOpacityStrength`'s existing feel unchanged without needing to rebake per window/level change. Shared by shading's normal and gradient-opacity's magnitude below; skipped entirely when neither needs it. (History: this step was a per-step forward-difference computation, 3 volume samples, until 2026-08-23's precompute; before that, central-difference, 6 samples, until 2026-08-22 — see Change History for both.) **Low-memory mode** (`_engine_load_volume`'s trailing `lowMemoryMode` argument, mobile OOM mitigation, see Change History's 2026-08-24 entry) reverses this per volume load: `gradientTexture_` is a 1×1×1 dummy (never baked) and this step instead calls `computeGradient()` (restored forward-difference, 3 extra `volumeTex` samples) — trading ~1.2ms/frame for not needing the gradient volume's memory (RGBA16Float, 4x the HU volume's own size) at all. `tfParams.z` (UBO) carries the flag; `zw` were previously both unused.
4. **Gradient-based Lambert shading** (`engine_set_shading_enabled`, a 3-state mode: `0`=off, `1`=on (default), `2`=on-flat, still supported at the engine level though the viewer no longer uses mode 2 as of 2026-08-23 — see Change History) — modes 0/1: the gradient from step 3 is used as a pseudo-normal; its N·L term against a fixed world-space light direction (`normalize(0.4,-0.6,0.7)`) multiplies color as `ambient(0.55) + diffuse(0.45)*max(N·L,0)*(1-occlusion*occlusionStrength)` (ambient raised from `0.35`/diffuse lowered from `0.65`, sum unchanged at `1.0`, issue #81 — a fixed key light rarely faces a typical orbit-camera's visible surfaces, so most of a shaded frame sat near the low ambient floor rather than the diffuse ceiling, reading as too dark). Mode `2` ("on-flat") applies the same formula but with a fixed representative diffuse term (`0.5`) instead of computing the real per-step gradient, skipping step 3 entirely (`needsGradient` is false in this mode unless gradient-opacity also needs it) without the brightness jump fully disabling shading caused (mode 0 skips the ambient/diffuse falloff itself, which most surfaces sat well below) — originally added so the viewer's camera-drag interaction could avoid step 3's sampling cost without that jump, but once step 3 itself became a single precomputed-texture read (2026-08-23), the remaining cost gap between mode 1 and mode 2 shrank enough (~0.6ms measured, down from ~1.9ms) that the viewer stopped using mode 2 at all rather than keep the approximation's own residual inaccuracy. Occlusion is also skipped in mode 2 (its own extra samples). The gradient is normalized per-axis by the volume's actual voxel spacing (`worldTexelSize`) so its direction isn't skewed on anisotropic volumes. **Directional Occlusion Shading** (optional, `engine_set_occlusion_enabled`, only has an effect when shading is on and not in flat mode) supplies the `occlusion` term: 3 short secondary density samples marching toward the light, averaged into an approximate self-occlusion factor — a cheap stand-in for a full self-shadow ray march.
5. **Beer-Lambert absorption compositing** — `alpha = 1 - exp(-extinction * sBar * stepSize)` (`extinction`, `engine_set_extinction`, default `8.0`), composited front-to-back, early-terminating once `accum.a > 0.99`.
6. **Threshold cutoff** (`engine_set_threshold`, default `0.0` = disabled) — if this step's `n` is below `threshold`, `alpha` is forced to `0` before compositing, letting background/noise be cut out independent of window/level.
7. **Gradient-magnitude opacity modulation** (`engine_set_gradient_opacity_strength`, default `0.0` = no-op) — a scoped-down stand-in for a full 2D transfer function (see §1.4a's note on why). `alpha` is re-weighted by `lerp(1.0, saturate(gradientMagnitude / 2.0), strength)`, suppressing homogeneous-region contributions and emphasizing edges as `strength` increases toward `1.0`.
8. **Mask overlay compositing** — skipped entirely when `engine_set_mask_overlay_enabled` is off (default on); the underlying mask texture is untouched either way, so toggling this back on redisplays already-received mask data with no re-fetch or re-inference. When on, the R8Uint mask texture is sampled via `Load` (nearest) and composites a fixed highlight color (`(1.0, 0.15, 0.15)`) at `engine_set_mask_opacity`'s alpha (default `0.6`), but only once per boundary *crossing* along the ray (previous step's class `== 0` and this step's `!= 0`), not on every step spent inside the mask — see Change History's 2026-08-23 "mask overlay boundary-crossing compositing" entry for why per-step compositing was replaced.
9. **Background composite + jitter + temporal accumulation** — the final `accum` is composited over a configurable background color (`ubo.backgroundColor`, `engine_set_background_color`, default `(0.05,0.05,0.12)` — Dark/Black/Gray/White presets in the viewer's "Background" panel section) and always returned with alpha=1 (see §1.4). Every frame, the ray's starting offset is jittered per pixel via interleaved gradient noise; while the camera/parameters are static, a `WGPUBlendFactor_Constant` blend accumulates a running average into a persistent buffer to reduce banding. Each new frame's blend weight is `1/(accumFrameIndex+1)`, and `accumFrameIndex` is capped at 31 (so the weight never decays toward zero indefinitely). Accumulation resets (goes dirty) on: `setWindowLevel`, `setColormapPreset`, `setQualityTier`, `setShadingMode`, `setExtinction`, `setDensityScale`, `setThreshold`, `setClipBox`, `setGradientOpacityStrength`, `setOcclusionEnabled`, `setCustomColormap`, `orbitCamera`, `zoomCamera`, `resize`, `loadVolume`, `applyMaskSlice`.

### 1.3 2D Axial Slice rendering (`axial_slice.slang`)

Per-pixel sampling of a fixed Z plane (`AxialSliceUBO`). After window/level normalization, it looks up the **256×1 1D classification LUT** directly (binding 4, see §1.6) — no pre-integration and no gradient shading apply (a single-plane view has no ray segment to pre-integrate over or shade along). Mask overlay is composited via `lerp`. Uses a "contain" letterbox fit so the volume's aspect ratio is preserved regardless of canvas aspect ratio.

### 1.4 Quality/resolution control (REQ-R04)

`engine_set_quality_tier(tier)` — `0=Low, 1=Medium (default), 2=High`. Per-tier target step count (across the AABB diagonal) and its safety-margin (1.33x) cap:

| Tier | stepsAcrossDiagonal | maxSteps |
| --- | --- | --- |
| Low | 192 | 256 |
| Medium (default) | 384 | 512 |
| High | 768 | 1024 |

**Anisotropic voxel spacing guard**: stepSize is additionally clamped to at most 1.5x the finest of the loaded volume's `spacingX/Y/Z` (`finestSpacing`), and `maxSteps` is grown to compensate so the ray still reaches the far face (final hard cap: 2048 steps). This guard is effectively inert on near-isotropic volumes.

### 1.4a TF detail and clip box controls

TF detail (`engine_set_extinction`, `engine_set_density_scale`, `engine_set_threshold`, `engine_set_gradient_opacity_strength`, `engine_set_occlusion_enabled`) — see §1.2 steps 2/4/5/6/7 for exactly how each applies. Gradient-magnitude opacity modulation is a deliberately scoped-down stand-in for a full 2D transfer function (intensity + gradient magnitude as two LUT axes, Kniss-style): the pre-integrated LUT (§1.6) already uses its second axis for the front/back sample pair, so a genuine second classification axis isn't available without a 3D texture, which wasn't judged worth the complexity yet.

Clip box (`engine_set_clip_box(minX, minY, minZ, maxX, maxY, maxZ)`) — restricts the raymarch traversal range to an axis-aligned sub-box of the loaded volume's world-space AABB, revealing interior structure without a full MPR view. Values are clamped to the volume's own AABB and to `min<=max` per axis. Reset to the full AABB on every `loadVolume()` call.

### 1.5 UBO layout

`RaymarchUBO` (336 bytes, kept byte-synchronized between C++ and Slang via `static_assert(offsetof(...))` on both sides):

```
invView, invProj             mat4 x2
cameraPos, aabbMin, aabbMax  vec4 x3 (world mm)
rayParams                    x=stepSize, y=maxSteps, z=extinction, w=densityScale
window                       x=center, y=width, zw=unused
maskParams                   x=overlayEnabled, y=overlayAlpha, zw=unused
shadingParams                xyz=light direction, w=shading enabled (0/1)
jitterParams                 x=accumFrameIndex, y=accumulation enabled (reserved, always 1), zw=unused
clipMin, clipMax             vec4 x2, world mm -- raymarch traversal bound (clip box)
occlusionParams              x=DOS enabled (0/1), y=strength (fixed 1.0, no slider yet), zw=unused
tfParams                     x=threshold, y=gradient-opacity strength, zw=unused
backgroundColor               xyz=RGB, w=unused -- engine_set_background_color
```

`AxialSliceUBO` (48 bytes) — `sliceParams`/`maskParams`/`fitParams`. Both structs share one `uboBuffer_` (sized for the larger of the two) and one 6-entry bind group layout. Clipping, extinction/density-scale/threshold, gradient-opacity, and DOS only affect the raymarch pipeline — the axial-slice view (§1.3) doesn't read any of `RaymarchUBO`'s new fields.

### 1.6 Texture bindings (bind group 0)

| Binding | Resource | Notes |
| --- | --- | --- |
| 0 | UBO | RaymarchUBO or AxialSliceUBO |
| 1 | Volume texture (R16Float, 3D) | HU values, trilinear |
| 2 | Sampler (linear) | Shared by volume + LUT textures |
| 3 | Mask texture (R8Uint, 3D) | `Load` only, never filtered |
| 4 | 1D classification LUT (256×1, RGBA8Unorm) | Sampled directly by the axial shader. Declared but not sampled by the raymarch shader (kept only so both shaders' bind group layouts stay identical) |
| 5 | Pre-integrated LUT (256×256, RGBA8Unorm) | Raymarch shader only. rgb = segment-average color, a = segment-average classification value (sBar) |
| 6 | Gradient texture (RGBA16Float, 3D) | Raymarch shader only, trilinear (same sampler as binding 1). Precomputed raw-HU gradient (issue #81's own follow-up, `gradient_bake.slang`) — xyz = dHU/d(x,y,z) in HU/mm, baked once per `loadVolume()` by a compute pass rather than sampled per raymarch step. Declared but not sampled by the axial shader, same reasoning as binding 4. In low-memory mode (mobile OOM mitigation, 2026-08-24) this is a 1×1×1 dummy instead — never baked, never sampled (the shader falls back to `computeGradient()`) |

Both LUT textures (bindings 4 and 5) are regenerated together whenever the colormap preset changes (`setColormapPreset`) — the color ramp plus window/level both change. A window/level-only change does not regenerate either LUT, since the classification curve itself is level-independent. Binding 6 is only rebaked on `loadVolume()` — window/level changes don't need it either, since it's baked on raw HU rather than windowed density (see its own §1.2 step 3 description for why).

### 1.7 Temporal accumulation / composite pipeline structure

Orbit3D rendering is now two passes:

1. **Accumulation pass** — `pipeline_` (raymarch) now renders into a persistent, canvas-sized offscreen `accumulationTexture_` (RGBA16Float) instead of the swapchain. If dirty: `loadOp=Clear` + blend weight 1.0 (full overwrite); otherwise: `loadOp=Load` + blend weight `1/(accumFrameIndex+1)`. This indirection exists because the swapchain returns a different physical texture every frame, so accumulating against it directly isn't possible.
2. **Composite pass** — a small separate blit pipeline (`accumulation_blit.slang`, `compositePipeline_`) draws `accumulationTexture_` straight to the swapchain.

`accumulationTexture_` is recreated at the new canvas size every time `resize()` is called.

### 1.8 Color transfer-function presets (REQ-R03)

`engine_set_colormap_preset(presetId)` — `0=Lung, 1=Bone, 2=Soft Tissue, 3=Brain, 4=Grayscale (default)`. Each preset carries window/level values plus a low/high RGB color pair; the LUT is a linear gradient between them (the alpha channel is always a plain `t*255` ramp regardless of preset — currently unused by either shader).

| Preset | Center/Width (HU) | Color |
| --- | --- | --- |
| Lung | -600 / 1500 | desaturated navy → pale sky blue |
| Bone | 300 / 1500 | dark brown → ivory |
| Soft Tissue | 40 / 400 | dark red-brown → soft pink |
| Brain | 40 / 80 | dark gray → warm light gray |
| Grayscale (default) | 40 / 400 | near-black → near-white, no color tint (traditional CT-film look) |

A 6th, user-defined **Custom** preset (`engine_set_custom_lut_colors(lowR,G,B, highR,G,B)`, values in `[0,1]`) is layered on top of these five — unlike the fixed presets, it doesn't change window/level, only the color ramp. Not one of `kColormapPresets`' indices; the "Custom" button in the UI is a visual-active-state indicator only (its click doesn't call `engine_set_colormap_preset`), while the two color pickers own actually applying the colors.

### 1.9 Controls exposed in the viewer UI

| Control | Panel section | WASM export |
| --- | --- | --- |
| Window Center / Width (slider + numeric entry) | Window & Level | `engine_set_window_level` |
| 5 preset buttons + Custom (6th, color pickers) | Window & Level | `engine_set_colormap_preset`, `engine_set_custom_lut_colors` |
| View mode (3D Orbit / 2D Slice) | View | `engine_set_view_mode` |
| Axial slice index | View | `engine_set_axial_slice_index` |
| Quality tier (Low/Medium/High) | Rendering | `engine_set_quality_tier` |
| Shading on/off | Rendering | `engine_set_shading_enabled` |
| Extinction / Density Scale / Threshold (slider + numeric entry) | TF Detail | `engine_set_extinction`, `engine_set_density_scale`, `engine_set_threshold` |
| Edge Emphasis (gradient-opacity strength) | TF Detail | `engine_set_gradient_opacity_strength` |
| Occlusion Shading on/off | TF Detail | `engine_set_occlusion_enabled` |
| Mask Opacity (slider + numeric entry) | TF Detail | `engine_set_mask_opacity` |
| Show Mask (on/off) | TF Detail | `engine_set_mask_overlay_enabled` |
| Clip X/Y/Z min+max sliders, Reset button | Clip | `engine_set_clip_box` |
| Background color (Dark/Black/Gray/White presets) | Background | `engine_set_background_color` |
| Camera orbit/zoom (mouse drag/wheel, not in the panel) | — | `engine_orbit_camera`, `engine_zoom_camera` |

### 1.10 Parameters not yet exposed via UI/export

Light direction / ambient & diffuse shading strength (fixed constants), occlusion strength (fixed at full effect when enabled — no slider yet), the color transfer function's second axis as a genuine classification axis (gradient magnitude is only used as an opacity modulator, §1.4a, not a second LUT axis). Mask overlay alpha and on/off are both exposed now (`engine_set_mask_opacity`, `engine_set_mask_overlay_enabled` — see §1.9's table). No further branch is currently planned against this list — pick these up if a concrete need comes up.

---

## 2. Change History

### 2026-08-20 — `feat/engine-raymarch-quality`

Implements the prioritized proposals §4.1/§4.2/§4.3/§6.1/§6.5/§6.6 from `docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md`. Before this, rendering was an unshaded raymarch sharing one fixed grayscale LUT across all presets, and the PRD's only unimplemented P0 requirement (REQ-R04, quality control) was still missing.

**Added:**

- REQ-R04 quality tiers (Low/Medium/High) + anisotropic-spacing-aware step-size correction
- Per-preset color LUTs (previously: one shared grayscale LUT)
- Gradient-based Lambert shading + on/off toggle
- Pre-integrated 2D LUT (256×256, front/back pair based)
- Jitter (interleaved gradient noise) + temporal accumulation (running average while static, capped at 31 frames)
- New UI: Rendering panel section (3 Quality buttons + Shading checkbox)
- New shader: `accumulation_blit.slang` (accumulation buffer → swapchain blit)
- New e2e: `viewer/tests/e2e/rendering-quality-controls.spec.ts`

**2 real bugs found and fixed along the way** (both caught by existing e2e tests regressing):

1. The raymarch pipeline switched to rendering into the accumulation buffer (RGBA16Float) but was still built against the swapchain's format (BGRA8Unorm), silently invalidating every draw using it — fixed by having `createRenderPipelineFor` take the color target format as a parameter.
2. The accumulation frame counter grew unbounded, so the blend weight decayed toward zero over time — new content (e.g. a mask slice arriving after the screen had already been sitting still for a while) stopped visibly affecting the image. Fixed with a 31-frame cap plus `markAccumulationDirty()` calls in `loadVolume`/`applyMaskSlice`.

**Deliberately out of scope:** full brick-atlas/LRU streaming, path tracing, full self-shadow ray-marching, a full 2D transfer function (Kniss-style) — see the gap-analysis document §5/§6 and the corresponding user decisions for why each was excluded.

**Verified:** native (`windows-default`) and WASM (`wasm-windows`) builds both pass. All 10 `viewer/tests/e2e/` tests pass (7 pre-existing + 3 new).

### 2026-08-20 — `feat/engine-clinical-shading-controls`

Branched directly off `feat/engine-raymarch-quality`'s tip (not off
`main`) to reuse its gradient computation, UBO layout, and pre-integrated-
LUT infrastructure. Implements the gap-analysis document's remaining
short-cost proposals: §6.4 (clip box), §6.2 (Directional Occlusion
Shading), §6.3's gradient-magnitude opacity modulation (a scoped-down
stand-in for a full 2D TF, not the real thing — see §1.4a), and §5.3 (TF
detail: extinction/density-scale/threshold sliders).

**Added:**

- Clip box (§6.4): restricts raymarch traversal to an axis-aligned
  sub-box of the AABB, reset to the full AABB on every volume load
- Directional Occlusion Shading (§6.2): cheap approximate self-shadow
  cue, 3 short secondary samples toward the light per step, only active
  alongside shading
- Gradient-magnitude opacity modulation (§6.3): reuses the shading
  gradient to suppress homogeneous-region noise and emphasize
  boundaries — a scoped-down stand-in for a full 2D TF (the
  pre-integrated LUT already occupies the second axis)
- TF detail (§5.3): extinction and density-scale switched from fixed
  constants to real setters; threshold cutoff added new
- Custom colormap (§5.3): a 5th, user-defined low/high color preset,
  independent of window/level
- New UI: TF Detail panel section (extinction/density-scale/threshold/
  edge-emphasis sliders + occlusion checkbox), Clip panel section
  (3-axis min/max sliders + reset), Custom preset button + 2 color
  pickers in Window & Level
- New e2e: `viewer/tests/e2e/clinical-shading-controls.spec.ts` (5 tests
  covering all of the above)

**Refactor along the way:** split `writeLutPreset`/`writePreintegratedLut`
(from the previous branch) into thin wrappers over new
`writeLutColors`/`writePreintegratedLutColors` helpers, shared with
`setCustomColormap` — avoids duplicating LUT-baking logic for the
index-less 5th preset. Moved `ColorRGB` from `WebGPUDevice.cpp`'s
anonymous namespace to `WebGPUDevice.hpp` so both the fixed-preset table
and the new helpers' signatures can reference it.

**UI bug found along the way:** the control panel got long enough
(Rendering, Window & Level, TF Detail, Clip) to exceed the viewport
height on shorter screens, with no way to reach the lower controls —
fixed by adding `max-height`/`overflow-y: auto` to `#control-panel`
instead of letting it overflow past the bottom edge uncontactably. Found
by the new e2e test failing with "element outside of the viewport", not
by visual review.

**Deliberately out of scope:** path tracing, full self-shadow ray-march
(Directional Occlusion Shading meets the same need far more cheaply, per
the gap-analysis document's own §5.1 note), a full 2D transfer function
using gradient magnitude as a genuine second classification axis — see
§1.4a/§1.10 above for why.

**Verified:** native (`windows-default`) + WASM (`wasm-windows`) builds
pass. All 15 `viewer/tests/e2e/` tests pass (10 pre-existing + 5 new).

### 2026-08-21 — `feat/engine-debug-overlay`

Not a rendering-technique change, but touches this spec in one place:
raymarch background color (§1.2 step 9) moved from a compile-time shader
constant (`kBackgroundColor` in `volume_raymarch.slang`) to a `RaymarchUBO`
field, set via `engine_set_background_color` and mirrored into every
render-pass clear color that previously hardcoded the same value (the
no-volume-loaded fallback, the 2D axial-slice letterbox bars) so there's
no visible seam. Default unchanged. Also adds the perf/hardware stats
overlay (`viewer/src/shell/statsOverlay.ts`,
`engine/tests/wasm_smoke/shell.html`) that `ENGINE_ROADMAP_2026-08-21.md`
§2's baseline measurements are built on — not itself a rendering feature.

**Verified:** native + WASM builds pass; manual verification in real
Chrome (live FPS/frame-time/GPU-info values, all four background presets
confirmed to actually change the rendered canvas via screenshot pixel
sampling, not just DOM state).

### 2026-08-21 — `feat/engine-gpu-timestamp-query`

`ENGINE_ROADMAP_2026-08-21.md` §2's first performance-work item. Also
not a rendering-technique change, but adds real instrumentation the spec
didn't have: `docs/current/PERF_BASELINE_2026-08-21.md`'s first sweep
found the render loop vsync-capped at typical desktop resolutions,
making wall-clock FPS/frame-time useless for comparing quality-tier GPU
cost until canvas resolution was pushed artificially high. This adds a
direct measurement that isn't vsync-limited.

**Added:**

- Feature-detected WebGPU `timestamp-query` (checked on the adapter
  before requesting the device; the device request only includes it in
  `requiredFeatures` if supported) — falls back to an explicit
  "unsupported" state rather than failing device creation.
- A single reused `WGPUQuerySet` (4 slots), wired via each render pass's
  `timestampWrites` descriptor field: raymarch + composite passes in
  Orbit3D mode, the single axial-slice pass in AxialSlice2D mode.
  Resolved + copied to a map-readable buffer within the same frame's
  command encoder, read back via the same async callback pattern this
  file already uses for adapter/device requests (no ASYNCIFY). A
  pending-flag skips starting a new readback while one is still in
  flight, rather than queuing.
- New `rhi::Device::getGpuTiming()` + matching WASM exports, surfaced as
  a new "GPU Pass" row in both debug overlays (`viewer/`'s and the
  engine's own test shell).

**Real bug found and fixed along the way:** the first working build hard-
crashed (`Aborted(Assertion failed...)`) the instant a volume was loaded
and the raymarch branch first tried to read the mapped buffer, via
`wgpuBufferGetMappedRange()` — that accessor is write-mode-only in this
emdawnwebgpu build (`WGPUBufferImpl::GetMappedRange` in Dawn's own
`webgpu.cpp` asserts `mode == WGPUMapMode_Write`, confirmed by reading
that source after hitting the assertion, not assumed); a buffer mapped
`WGPUMapMode_Read` needs the const-returning
`wgpuBufferGetConstMappedRange()` instead. A second, non-crashing bug
found via manual verification: after switching from Orbit3D to
AxialSlice2D, the overlay kept showing the last (stale) raymarch/
composite numbers instead of the new axial one, since
`onTimestampBufferMapped()` only ever wrote whichever pass-pair's slots
its own frame touched and never cleared the other pair. Fixed by
clearing the complementary pair's values whenever a fresh measurement
for one arrives. A third bug, reported by the user as rapid continuous
rendering flicker (not caught by the automated e2e suite, which doesn't
watch for this): `timestampReadbackBuffer_` was resolved into and
copied into again every single frame regardless of whether the
*previous* frame's async `wgpuBufferMapAsync()` readback of that same
buffer had actually completed yet — GPU readback latency is several
frames at this frame rate, so nearly every submission referenced a
buffer still mapped or pending-map, which WebGPU forbids. Confirmed via
the browser console, not assumed: Dawn logged `"[Buffer (unlabeled)]
used in submit while mapped"` on ~130 of ~140 console messages during a
3-second capture. Fixed by gating the pass(es)' `timestampWrites`,
the resolve/copy, and the readback kickoff all on a single
`!timestampReadbackPending_` check computed once per frame — skipping
the whole timestamp dance entirely on frames where a previous readback
hasn't resolved yet, rather than trying to resolve into a buffer that's
still in use.

**Verified:** native + WASM builds pass; all 20
`viewer/tests/e2e/` tests still pass (no regressions). Manual
verification in real Chrome: at 1280×900 (where the first baseline
sweep saw nothing but the vsync cap), raymarch now reads ~2.2ms/
composite ~0.01ms directly; at 4K, ~12.2ms raymarch — consistent with
the first baseline sweep's indirect wall-clock-derived estimate (~13ms)
at that resolution, cross-validating both measurement methods against
each other. Confirmed all four states behave correctly: no volume
loaded ("n/a"), Orbit3D, 4K Orbit3D, and AxialSlice2D (showing its own
axial number, not stale raymarch data). After the third fix: zero
`"used in submit while mapped"`/`"while pending map"` warnings over the
same 3-second capture window (down from ~130+), and the reported
flicker no longer reproduces.

### 2026-08-21 — `feat/viewer-mobile-render-perf`

Not a rendering-technique change, but the first fix driven by a real
mobile-device measurement instead of desktop-only simulation
(`docs/current/PERF_BASELINE_2026-08-21.md` §7-10, issue #69): an iPhone
14 Pro (Chrome, portrait) rendered the demo CT at 5.6fps/178.6ms —
unusable. Root cause was mostly a missing `<meta name="viewport">` tag
(`viewer/src/shell/index.html`) — without it, mobile browsers fall back
to the ~980px desktop-compat layout viewport and scale the page down for
display, but the canvas's `100vw`/`100vh` sizing resolves against that
inflated virtual viewport, not the real screen — compounded by an
uncapped `devicePixelRatio` multiplier on top.

**Added (all viewer-side JS/HTML — no new engine API; reuses the
existing `engine_set_quality_tier`/`engine_resize` exports):**

- The missing `<meta name="viewport">` tag.
- Canvas backing resolution capped at `devicePixelRatio<=1`
  (`canvasResize.ts`) — chosen over a higher cap after a real-device A/B
  on the same phone (2: 26.8fps vs 1: 48.9fps, nearly double) found
  volumetric raymarch content shows far less perceptible benefit from
  DPR supersampling on a small screen than text/vector UI would. A
  diagnostic-only `?dpr=<n>` URL override (not product-facing) exists
  for gathering exactly this kind of data without a rebuild.
- Interaction-adaptive quality: the engine's active tier drops to Low
  for the duration of a camera drag and restores the user's selected
  tier on release (`qualityControls.ts`/`cameraControls.ts`) — the
  user's own tier selection and its button UI are unaffected throughout.
- Startup auto-tier: if the first few seconds' measured average frame
  time is worse than PRD's own 15fps low-spec floor, the starting tier
  automatically drops to Low once (never overriding a tier the user
  explicitly picks afterward).
- `?debug=1` URL param starts the stats overlay visible and the control
  panel collapsed, so a real-device test doesn't need to reach a
  checkbox that can end up under the mobile browser's own bottom
  toolbar.

**Real-device verification (iPhone 14 Pro, Chrome, portrait) — full
methodology, all three measurements, and the regression separating
fixed per-frame cost from resolution-scaled cost in
`docs/current/PERF_BASELINE_2026-08-21.md` §7-10:** 5.6fps/178.6ms
(before) → 48.9fps/20.4ms (after, DPR capped at 1) — roughly **8.7x**. A
render-scale mechanism (decoupling the raymarch's internal render target
size from the canvas's displayed size, a heavier engine-side change) was
considered but dropped from this branch's scope: a 3-point linear
regression across all three real-device measurements found ~21.7ms of
the remaining frame cost is resolution-independent fixed overhead (not
pixel-count-driven), leaving little headroom for a resolution-only
lever — even the DPR=1 measurement above already sits close to that
estimated floor.

**Deliberately out of scope:** identifying the source of the ~21.7ms
fixed per-frame cost (WebGPU per-call driver overhead crossing from WASM
into the browser's own WebGPU implementation is the leading hypothesis,
unconfirmed — needs real profiling tooling, e.g. Safari Web Inspector,
not available this session); the render-scale mechanism above.

**Verified:** no engine (C++) changes in this branch — viewer-only, so
native/WASM engine builds are unaffected. Full `viewer/tests/e2e/` suite
(23 tests, 2 new — `mobile-render-perf.spec.ts`) passes.

### 2026-08-22 — `feat/viewer-interaction-adaptive-shading`

Not a rendering-technique change, but extends the interaction-adaptive
mechanism the previous entry added: that entry only dropped the active
quality tier (step count) during a camera drag. `qualityControls.ts` now
also forces shading and occlusion shading off for the same duration,
restoring each to whatever the user actually had selected once the drag
ends — occlusion in particular does its own extra per-step sampling
(§1.4a), so leaving it on during a drag was one of the pricier toggles
still uncovered by the previous fix. The occlusion checkbox
(`tfDetailControls.ts`) now calls `qualityControls.ts`'s
`notifyOcclusionSelection()` instead of `engine_set_occlusion_enabled`
directly, so its selection passes through the same interaction gate the
tier buttons and shading checkbox already used.

**Verified:** no engine (C++) changes — viewer-only. Full
`viewer/tests/e2e/` suite (24 tests, 1 new) passes; the new test wraps
the real `_engine_set_shading_enabled`/`_engine_set_occlusion_enabled`
WASM exports and asserts both are actually called with 0 during a
simulated drag and restored to the pre-drag selection (occlusion
explicitly turned on first, so the restore is unambiguous) on release.

**Correction (2026-08-22, see the next entry below):** this entry's own
claim that occlusion is "one of the pricier toggles" was an unverified
assumption, not a measurement. A direct GPU-cost sweep afterward found
the opposite: shading (the gradient computation) is responsible for
~71% of this pass's per-step cost, occlusion only ~3%. Kept here
unedited for an accurate record of what was believed at the time;
extending the mechanism to both was still the right call (neither
toggle is harmful to force off), just not for the reason originally
given.

### 2026-08-22 — `feat/engine-forward-diff-gradient`

Follow-up to the previous two entries: a real-device investigation
(`docs/current/PERF_BASELINE_2026-08-21.md` §11-12) found shading's
gradient computation (§1.2 step 3) responsible for ~71% of the
raymarch pass's per-step cost, versus ~3% for occlusion shading —
correcting the previous entry's unverified assumption that occlusion
was the pricier of the two. `computeGradient()`
(`engine/shaders/src/volume_raymarch.slang`) switched from
central-difference (6 volume samples: +/-x/y/z) to forward-difference
(3 samples: +x/+y/+z), reusing `fragmentMain`'s own already-sampled
center point `n` instead of re-sampling it a second time. Magnitude is
scaled by `2.0` to preserve the original central-difference convention
(and `gradientOpacityStrength`'s existing feel) unchanged; direction is
unaffected either way (`normalize()` removes any uniform scale factor).
Trades a small amount of directional accuracy (first-order vs
central-difference's second-order approximation) for half the sampling
cost.

**Measured (same real-device methodology as §11-12, Medium tier,
default view, 2560×1440):** shading's marginal cost dropped from
+4.35ms to +1.88ms (~57% reduction, slightly better than the ~50% a
pure sample-count halving would predict — reusing the center sample
removes a redundant fetch too). Total raymarch cost with shading and
occlusion both on: 6.15ms → 4.26ms (~31%).

**Verified:** shader compiles cleanly to both WGSL (`wasm-windows`) and
SPIR-V (native `windows-default`, `compile_shaders` target built
explicitly since nothing links it into the native build yet — see §7
of `CLAUDE.md`/build docs). Native `ctest` passes. Full
`viewer/tests/e2e/` suite (24 tests) passes with no regressions —
screenshot-based tests confirm shading on/off still visibly changes the
frame, i.e. shading still does something, not just that nothing broke.

### 2026-08-23 — `fix/engine-shading-flat-interaction-mode`

Follow-up to the previous entry's own interaction-adaptive mechanism
(the one before that, `feat/viewer-interaction-adaptive-shading`,
forced shading fully off during a camera drag). A real Android-device
test caught what that entry's own "no user-visible functional change"
claim missed for shading specifically: switching shading off outright
during a drag caused a visible brightness pop the instant the drag
started, since it skips the ambient/diffuse falloff itself (a
multiplier of at most `1.0`, as little as the ambient floor) rather
than approximating it. The same test session separately found the
always-shaded default view "too dark".

**Added:** `rhi::Device::setShadingMode`/`WebGPUDevice::setShadingMode`
(renamed from `setShadingEnabled`, now `uint32_t` instead of `bool` --
the WASM export `engine_set_shading_enabled` keeps its old name to
avoid an unrelated JS-side rename, but now accepts `0`/`1`/`2`) — mode
`2` ("on-flat") is the viewer's new interaction-drag state, described
in §1.2 step 4 above.

**Changed:** `kShadingAmbient`/`kShadingDiffuse` from `0.35`/`0.65` to
`0.55`/`0.45` (sum unchanged at `1.0`), addressing the "too dark"
finding directly and narrowing the gap between real shading and mode
2's fixed approximation as a side effect (real per-surface values sit
closer to the new, higher floor to begin with).

**Deliberately left open:** mode 2's brightness still isn't an exact
match for real shading (a single fixed diffuse term can't be, for every
possible view) -- the pop is smaller now, not eliminated. Actually
eliminating it means making real shading (mode 1) itself cheap enough
to never need mode 2 at all, which is a separate, larger investment
(precomputing the gradient at load time instead of sampling it per
step) tracked as follow-up work, not part of this fix.

**Verified:** shader compiles cleanly to both WGSL and SPIR-V (native
`compile_shaders` target built explicitly, same as the previous entry).
Full `viewer/tests/e2e/` suite (24 tests) passes, including an updated
regression test asserting the engine's shading mode actually becomes
`2` (not `0`) during a drag and restores to `1` on release. Manual
real-device verification: iPhone 14 Pro and an Adreno 7xx Android
phone both confirmed the default view is visibly brighter after the
ambient change; the interaction pop is reduced but not fully gone,
consistent with the "deliberately left open" note above.

### 2026-08-23 — gradient volume precompute (compute pass)

The follow-up the previous entry itself flagged: precomputes the
raymarch gradient once per `loadVolume()` (a new compute pass,
`gradient_bake.slang`, this engine's first) instead of sampling it every
raymarch step. Written on *raw* HU rather than window/level-normalized
density, deliberately -- window/level is an interactive per-frame
control, and baking would otherwise need to re-run on every slider
change; raw-HU gradient is window-independent (§1.2 step 3's own
comment explains the conversion math), so one bake per volume load
suffices. One documented behavior difference from the runtime
computation it replaces: the old code computed on already
window-clamped samples, so regions fully outside the current window
read as gradient-free there -- this bake doesn't replicate that
clamp-boundary zeroing (raw HU has no notion of the current window), so
shading detail can now show through in regions the window would
otherwise flatten. Not replicated deliberately, not a regression --
that zeroing was a side effect of the old approach, not a documented
design goal.

**Two real bugs found and fixed getting the compute pass working (both
confirmed via the browser console, not assumed):**

1. Rendering went completely black on load. Root cause: the default
   WebGPU `maxBufferSize` (256 MiB) is smaller than the gradient
   texture's own byte size for the demo CT (~266 MiB) -- Dawn's internal
   lazy-clear-before-first-use for a storage texture that large needs a
   staging buffer as big as the texture itself, which silently failed
   validation against the default limit, firing every frame. Fixed by
   requesting a higher `maxBufferSize` (512 MiB, clamped to whatever the
   adapter actually reports supporting via `wgpuAdapterGetLimits` --
   feature-detected, not assumed available) when requesting the device.
2. `[[vk::binding(1,0)]] RWTexture3D<float4> gradientTex` compiled to a
   WGSL `read_write` storage texture regardless of the shader body only
   ever writing it -- and WebGPU's base feature set doesn't support
   read-write storage access for most formats, RGBA16Float included
   (only a handful of single-channel 32-bit ones do), so the
   WebGPUDevice-side bind group layout (declared `WriteOnly` to match
   the intended usage) failed validation against that `read_write`
   shader declaration. Fixed by using Slang's `WTexture3D<float4>` (a
   genuinely distinct write-only resource type, not just an attribute on
   `RWTexture3D`) with `.Store()` instead of `[]=` -- confirmed via both
   the WGSL output (`texture_storage_3d<rgba16float, write>`) and the
   SPIR-V output (a `NonReadable`-decorated image) that this compiles to
   real write-only access on both backends, not assumed from the type
   name alone. A `[format("rgba16f")]` attribute was needed either way --
   an `RWTexture3D`/`WTexture3D` with no format hint gets slangc's own
   best-guess format (`rgba32float` for a `float4` element type), which
   silently mismatched this texture's actual RGBA16Float C++-side format
   until this was added.

**Measured (same real-device methodology as the previous two entries,
Medium tier, default view, 2560×1440):** shading's marginal cost over
shading-off dropped from +1.88ms (forward-difference, previous entry)
to **+0.67ms** -- roughly 85% down from the original central-difference
entry's +4.35ms across all three changes combined. More importantly,
the gap between real shading (mode 1) and its flat interaction-mode
approximation (mode 2) shrank to ~0.6ms (was ~1.9ms) -- small enough
that `qualityControls.ts` was simplified to stop using mode 2 at all:
shading now always reflects the user's actual selection, interacting or
not, which also fully closes out the previous entry's "brightness pop
reduced but not eliminated" finding by removing the interaction-time
mode switch that caused it in the first place. Mode 2 itself is
unchanged at the engine level (still a supported, tested value) in case
a future need for it resurfaces.

**Verified:** shader compiles cleanly to both WGSL and SPIR-V (native
`compile_shaders` target built explicitly, same as prior entries).
Native `ctest` passes. Full `viewer/tests/e2e/` suite (24 tests, 1
rewritten to match the new no-mode-2-during-drag behavior) passes.
Manual verification: real Chrome screenshot after the fix shows the
demo CT rendering correctly (no regression from the black-screen bug
above), visually consistent with pre-precompute screenshots.

### 2026-08-23 — mask overlay boundary-crossing compositing

Reported against real usage: lowering the mask overlay's alpha made
mask boundaries look *blurrier*, not more transparent, and a thick mask
region's interior stayed dark red regardless of how low the alpha went.
Root cause: the raymarch's mask block ran the same front-to-back
compositing formula the density pass uses
(`accum.rgb/accum.a += (1-accum.a) * ... * alpha`) on *every* step
where the mask was present, not once. That formula is correct for a
substance whose apparent opacity should legitimately grow with how much
of it a ray passes through (e.g. absorptive haze) -- but a segmentation
mask is a boundary label, not a substance with thickness, so per-step
compositing meant a ray through a thick region of the mask converged
toward `accum.a == 1` (fully opaque highlight) within a few steps
regardless of `maskAlpha`, while the transition zone at the boundary
itself spanned however many steps it took to build up that accumulation
-- read as "blurry edge, opaque interior," exactly the opposite of the
intended crisp highlighted boundary.

**Changed:** the mask block now tracks the previous step's class
(`prevMaskClass`) and only composites the highlight on a *crossing*
(`prevMaskClass == 0 && maskClass != 0`) -- once per boundary the ray
passes through, not once per step spent inside the mask. `maskAlpha`
now means exactly what its configured value implies (this crossing's
own opacity), independent of how thick the masked region is along that
ray, and the boundary itself is as sharp as a single step (no
multi-step accumulation ramp). A ray that clips directly into a mask's
interior (e.g. via the clip box) still highlights correctly, since
`prevMaskClass` starts at `0`, making the first sampled step read as a
crossing.

**Deliberately not done:** no separate "interior wash" tint for the
masked region's interior beyond the boundary highlight -- the ask this
addresses was specifically that a wash-style fill couldn't be made to
look transparent, not a request to remove all interior indication. If a
faint, non-accumulating interior tint is wanted later, it would need
its own single-composite-per-crossing-style guard (not a naive per-step
add) to avoid reintroducing this exact bug.

**Verified:** shader compiles cleanly to WGSL and SPIR-V, both the
`wasm-macos` and native `compile_shaders` targets. Native `ctest`
unaffected (shader-only change). Confirmed fixed via real-device mobile
testing over a Cloudflare tunnel.

### 2026-08-23 — fix dangling `requiredFeatures` pointer in device request

Found via a real-browser console error on a device whose adapter
actually supports `timestamp-query` (the `feat/engine-gpu-timestamp-query`
entry above): `WebGPUDevice: device request failed: ... Failed to read
the 'requiredFeatures' property from 'GPUDeviceDescriptor': The provided
value 'undefined' is not a valid enum value of type GPUFeatureName`.
`onAdapterRequested()` declared the one-element `requiredFeatures` array
*inside* the `if (timestampQuerySupported_)` block, then pointed
`deviceDesc.requiredFeatures` at it -- but `wgpuAdapterRequestDevice()`
is called after that block's closing brace, i.e. after the array's
lifetime has already ended. Reading through the resulting dangling
pointer is undefined behavior; in this Emscripten build it surfaced as
Dawn's JS glue marshaling whatever stale stack bytes were there into an
invalid `GPUFeatureName` enum value rather than a native crash, which is
why device creation failed cleanly (with a message) instead of hard
faulting. Not caught earlier because the previous review environment
(a Playwright sandbox with no WebGPU adapter at all) never exercised
this branch. Fixed by hoisting the array to the same scope as
`deviceDesc`, so its lifetime covers the request call in both branches.

**Verified:** `wasm-macos` rebuilds cleanly. Native `ctest` unaffected
(this file isn't part of the native build target). Confirmed fixed via
real-device mobile testing over a Cloudflare tunnel, on the same
adapter/browser that originally hit the bug.

### 2026-08-23 — mask overlay opacity control + Grayscale default preset

Two small, independent UI/rendering asks. Both touch the same two
files' worth of already-existing plumbing rather than adding anything
structurally new.

**Mask overlay opacity:** `maskParams.y` (`overlayAlpha` in both
`RaymarchUBO` and `AxialSliceUBO`, §1.5) was already declared and read
by both shaders, but the C++ side never backed it with a real member --
both UBO-population call sites wrote a literal `0.6F` directly. Added
`rhi::Device::setMaskOverlayAlpha`/`WebGPUDevice::setMaskOverlayAlpha`
(clamped `[0,1]`, backed by a new `maskOverlayAlpha_` member defaulting
to the same `0.6F`) and the `engine_set_mask_opacity` WASM export, wired
to a new "Mask Opacity" slider in the TF Detail panel
(`tfDetailControls.ts`). No UBO layout change, no bind-group change --
the field already existed on both sides of the C++/shader boundary.

**Grayscale default preset:** `kColormapPresets` gains a 5th entry
("Grayscale", same 40/400 HU window as Soft Tissue, near-black →
near-white with no color tint) and `kDefaultColormapPreset` moves from
`2` (Soft Tissue) to `4` (Grayscale) -- none of the four original
presets was a true neutral ramp, and Soft Tissue's warm salmon tint was
the first thing every newly loaded volume showed. Custom (the
user-defined 6th colormap, `customColormapControls.ts`) shifts from
`data-colormap-preset="4"` to `"5"` in the UI to make room, with
`windowLevelControls.ts`'s special-case check updated to match --
`kColormapPresets`' own array bounds check (`setColormapPreset`)
required no change since it already sizes off `.size()` rather than a
hardcoded constant.

**Verified:** native `ctest` passes (unaffected -- these files aren't
part of the native build target). The `wasm-macos` CMake preset rebuilds
cleanly with no errors, and `viewer`'s `vite build` bundles the changed
TS with no errors. The `viewer/tests/e2e/` suite itself could not be
run to completion in this environment -- every spec fails identically
at the initial `#shell-status` "ready for input" wait with "engine
failed to start" (no WebGPU adapter available to Playwright's Chromium
in this sandbox). Confirmed this is pre-existing and unrelated to this
change: reverting to HEAD (`git stash`), rebuilding, and re-running the
same spec reproduces the identical failure. Existing preset-related
assertions reference fixed presets 0-2 (Lung/Bone/Soft Tissue) and the
`#custom-preset-button` element ID directly, none of which depend on
the default preset's index or on Custom's `data-colormap-preset` value,
so no test updates were needed -- but real e2e/manual re-verification in
an environment with a working WebGPU adapter is still owed before merge.

### 2026-08-24 — mask overlay show/hide toggle, viewer progress gauges

Three small usability asks: an on/off toggle for the mask overlay
(separate from its opacity slider, added above), and a visual progress
gauge on the "Load Demo CT" and "Load Segmentation Model" buttons.

**Mask overlay on/off:** `maskOverlayEnabled_` already existed
(hardcoded `true`, no setter) -- added
`rhi::Device::setMaskOverlayEnabled`/`WebGPUDevice::setMaskOverlayEnabled`
and the `engine_set_mask_overlay_enabled` WASM export, wired to a new
"Show Mask" checkbox in the TF Detail panel. The engine skips the mask
block entirely when off, but never touches the mask texture itself --
switching back on redisplays whatever mask data has already arrived,
with no re-fetch or re-inference (the "caching" behavior this was
requested as -- it falls directly out of the existing texture-backed
mask storage; no new cache was built).

**Viewer progress gauges (`viewer/`, not this engine module, but
recorded here since the ask arrived alongside the mask toggle):** a new
`buttonGauge.ts` primitive (a semi-transparent fill `<span>` plus a
label `<span>`, both children of the button, so updating the label
doesn't blow away the fill the way a plain `button.textContent =`
assignment would) is now used by:
- `demoCtControls.ts`'s "Load Demo CT" button -- fraction = slices
  fetched / total, reusing counters that already existed for the
  button's old text-only status.
- `inferenceControls.ts`'s "Load Segmentation Model" button, across two
  phases sharing the same gauge: first the model's own byte download
  (new `fetchModelBytes()` in `worker.ts`, replacing the URL-string form
  of `ort.InferenceSession.create()` with a manual `fetch()` + streamed
  `Content-Length`-tracked read, so progress can be observed at all --
  ORT gives no hook into its own internal fetch), then -- once
  `init-complete` fires -- how many of the currently loaded volume's
  slices have actually been segmented so far (`notifyVolumeLoadedForInference`/
  `notifyMaskSliceApplied`, called from `main.ts` at the existing
  volume-ready/mask-slice handling sites). The two phases never overlap
  (segmentation can't start before the model is ready), so one gauge
  represents both without ambiguity. When `Content-Length` is missing,
  the gauge falls back to an indeterminate striped-animation state
  (`prefers-reduced-motion`-aware) rather than claiming a specific
  percentage the code doesn't actually know.

**Verified:** `wasm-macos` and native `compile_shaders` rebuild cleanly.
Native `ctest` passes (unaffected). `viewer`'s `vite build` and the
inference-worker package's `tsc --noEmit` both pass with no errors.
`inference-worker`'s `vitest` suite: 2 passed, 7 failed -- confirmed
pre-existing and unrelated (missing `ai-pipeline/quantization/calibration_data/`
fixture files in this environment, not this change) by re-running the
same suite with `worker.ts` reverted to `HEAD` and observing the
identical 7 failures. `viewer/tests/e2e/` could not be run to completion
in this environment for the same no-WebGPU-adapter reason as the
previous two entries -- real browser/e2e and manual mobile
re-verification still owed before merge.

### 2026-08-24 — REQ-C03 first parity test: known-answer mask geometry

First code under REQ-C03 ("cross-checking AI inference output against
rendering output for known-answer synthetic volumes" -- see
`claude.md` §6, corrected there from an earlier, wrong
Vulkan-vs-WebGPU-backend-diff framing). Scoped to what's testable
without the AI track's inference output: given a known-answer mask
tensor matching the REQ-C01 shape, does the render output place it at
the geometrically correct location.

Investigated `WebGPUDevice::applyMaskSlice` first to see what a native
CTest could exercise: it's a direct per-slice overwrite with no
coordinate transform at all (the mask must already match the volume's
width/height exactly), so there's nothing in the C++ layer for a
coordinate-flip bug to hide in -- the only place such a bug could live
is the raymarch/axial fragment shader's own texture-coordinate math,
which requires a real GPU. The WebGPU backend only builds under
`EMSCRIPTEN` (no native Vulkan `Device` implementation exists), so this
had to be a Playwright e2e test, not `engine/tests/parity/` CTest.

`viewer/tests/e2e/mask-geometry-parity.spec.ts`: loads a synthetic
64x64x1 HU=0 volume (uniform HU means the all-zero float16 bit pattern
works directly, no conversion code needed) and a known-answer mask
(class 1 in the top-left quadrant only, 0 elsewhere) via
`_engine_load_volume`/`_engine_apply_mask_slice` directly (same
direct-injection technique `shell-mask-integration.spec.ts` uses),
switches to the 2D axial slice view, and checks four quadrant
screenshots: the masked quadrant must differ from all three others, and
the three unmasked quadrants must be mutually identical (catches a
misplaced highlight landing in any wrong quadrant, not just the
"looks different somewhere" case a single before/after diff would
under-specify). Volume and viewport are both forced square so
`axial_slice.slang`'s "contain" letterbox fit (`fitParams`) resolves to
an identity, keeping the screen-pixel-to-UV mapping undistorted.
Deliberately mis-placed the known-answer mask (top-right instead of
top-left) to confirm the test actually fails when it should, before
trusting the passing result.

One dead end worth recording: a `page.evaluate`-side
`drawImage(sourceCanvas, ...)` + `getImageData` pixel readback always
returned fully transparent (0,0,0,0) against this WebGPU-backed canvas
(confirmed via a throwaway debug script, cause not pinned down) --
switched to `page.screenshot({clip})`, the same real-render capture
`mask-opacity-controls.spec.ts` already relies on.

**Verified:** full `viewer/tests/e2e/` suite (29 specs) run to
completion -- all pass except one `control-tooltips.spec.ts` case that
fails only under full-suite serial load and passes cleanly on its own,
consistent with WebGPU-adapter contention across many real-GPU tests in
one run, not a regression from this change.

Native-CTest half of REQ-C03 (once a native Vulkan `Device` exists) and
the joint AI-track half (real inference output, error-tolerance
criteria) remain open -- see `docs/current/TESTS_PARITY_TODO_2026-08-24.md`
(local/gitignored).

### 2026-08-24 — gradient volume low-memory fallback (mobile OOM mitigation, Option A)

Real, reproduced crash: iPhone 14 Pro + Chrome (WebKit on iOS), rendering +
FP16 inference concurrently -- white screen, page reload, no crash log or
JS exception, consistent with an iOS WebKit per-tab memory ceiling being
exceeded (OS-level jetsam kill). Measured root cause: for the demo CT
(512×512×133 voxels), Engine's own 3D textures total ≈366MB, of which
`gradientTexture_` (RGBA16Float, added by the 2026-08-23 precompute entry
above) is 266MB -- 73% of that, and 4x `volumeTexture_`'s own size, purely
because RGBA16Float is 4x R16Float's bytes-per-texel.

That 2026-08-23 decision is **not reversed** -- it's still the right
tradeoff when memory isn't the bottleneck. This adds a second, conditional
path, decided once per volume load via `_engine_load_volume`'s new trailing
`lowMemoryMode` argument (threaded through `rhi::Device::loadVolume` /
`WebGPUDevice::loadVolume` / `engine_load_volume`). When set:
`gradientTexture_` is created as a 1×1×1 dummy (`TextureBinding` usage
only, no `StorageBinding`) instead of a full-volume texture, and
`bakeGradientVolume()` is never called -- `rebuildBindGroup()`'s binding-6
entry needs no change (bind-group-layout validation only checks sample
type/dimension, not extent). `RenderGraph` needed no changes either --
`"gradient"` was never a resource it tracked. The shader
(`volume_raymarch.slang`) restores `computeGradient()` (forward-difference,
the function this project used before the 2026-08-23 precompute existed)
as the low-memory branch, selected via a UBO flag riding in
`tfParams.z` (previously unused, no `RaymarchUBO` size/offset change) --
costs ~1.2ms/frame more per the earlier forward-diff-vs-precompute
measurement, in exchange for not allocating the 266MB texture at all.

This PR does not by itself decide *when* low-memory mode is used --
that's a separate device-tier signal (`navigator.deviceMemory` + an iOS
UA fallback, tracked separately) feeding this new parameter; until that
lands, the one real call site (`main.ts`'s `engineLoadVolume`) hardcodes
`0` (full mode), so this change is inert in production today.

**Verified:** `wasm-macos` rebuilds cleanly (native `ctest` unaffected --
this is WASM/WebGPU-only code). New
`viewer/tests/e2e/gradient-low-memory-mode.spec.ts`: loads a synthetic
solid-sphere-against-uniform-background volume (density uniform within
each region, so any spatial luminance variation on the sphere's own
surface must come from shading, isolating it from the transfer
function's own color variation) twice, full mode and low-memory mode,
and checks the two renders are visually close (mean-absolute-pixel-diff
threshold) and neither collapses toward flat/degenerate shading
(luminance-stddev ratio threshold). Both thresholds were calibrated
against a real mutation test (temporarily swapping which branch each
mode takes, so low-memory mode wrongly sampled the unbaked dummy texture)
to confirm the checks actually fail on a broken fallback, not just
pass vacuously -- an earlier version of this test used a smooth HU ramp
instead of a sphere and this same mutation test caught that the ramp's
own continuous transfer-function color variation drowned out any signal
from degenerate shading, passing even when badly broken; the sphere
redesign fixed that. Full `viewer/tests/e2e/` suite (30 specs) run to
completion, all passing.

<!-- Next entry: whatever follow-up comes out of the ~21.7ms fixed-cost investigation flagged several entries back, once real profiling access exists -->
