# Rendering Spec

| Field | Value |
| --- | --- |
| Status | Living document (git-tracked) — every time a rendering-related branch merges, update "1. Current Spec" to reflect the new state and append an entry to "2. Change History" |
| Written | 2026-08-20 |
| Purpose | (1) Give one place to see exactly what the engine renders and what's currently tunable, and (2) keep a record of why/when each change landed. Where `docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md` (local-only, gitignored) was the analysis that proposed a direction, this document is the spec that reflects only what was actually implemented and merged from those proposals. |

---

## 1. Current Spec

### 1.1 View mode

`engine_set_view_mode(mode)` — `0 = Orbit3D` (default), `1 = AxialSlice2D`. Each uses a distinct shader/pipeline and its own UBO struct (`RaymarchUBO` vs `AxialSliceUBO`, see §1.5).

### 1.2 3D Orbit volume rendering (`volume_raymarch.slang`)

Front-to-back raymarch through an R16Float HU 3D texture. The ray's traversal range (`tNear`/`tFar`) is computed against the **clip box** (§1.4a), not the volume's full AABB — texture sampling coordinates (`uvw`) stay anchored to the full AABB regardless, so clipping only shortens/moves the visible range without touching how the volume or mask textures are sampled. Per step:

1. **Window/level normalization** — clamps raw HU into `[0,1]` as `n`, using `windowCenter`/`windowWidth`. (`engine_set_window_level`, `engine_set_colormap_preset`)
2. **Pre-integrated transfer-function lookup** — samples a 256×256 2D LUT (binding 5) at `(frontN, backN)` to get this step segment's average color (`colorBar`) and average classification value (`sBar`). Compared to a single-point classification, this reduces thin high-contrast structures being missed between steps at low quality tiers (fewer/coarser steps). When `sf==sb` (consecutive steps' `n` values are nearly equal) it converges to the original single-point classification exactly. `sBar` is then scaled by `densityScale` (§1.4a, default `1.0` — no change) before it reaches absorption.
3. **Gradient computation** — a central-difference gradient of the *windowed* density `n` (not raw HU, so its magnitude stays in a bounded, window-relative range) is computed once per step, shared by shading's normal and gradient-opacity's magnitude below. Skipped entirely when neither shading nor gradient-opacity is active, to avoid the extra sampling cost.
4. **Gradient-based Lambert shading** (optional, `engine_set_shading_enabled`) — the gradient from step 3 is used as a pseudo-normal; its N·L term against a fixed world-space light direction (`normalize(0.4,-0.6,0.7)`) multiplies color as `ambient(0.35) + diffuse(0.65)*max(N·L,0)*(1-occlusion*occlusionStrength)`. The gradient is normalized per-axis by the volume's actual voxel spacing (`worldTexelSize`) so its direction isn't skewed on anisotropic volumes. **Directional Occlusion Shading** (optional, `engine_set_occlusion_enabled`, only has an effect when shading is also on) supplies the `occlusion` term: 3 short secondary density samples marching toward the light, averaged into an approximate self-occlusion factor — a cheap stand-in for a full self-shadow ray march.
5. **Beer-Lambert absorption compositing** — `alpha = 1 - exp(-extinction * sBar * stepSize)` (`extinction`, `engine_set_extinction`, default `8.0`), composited front-to-back, early-terminating once `accum.a > 0.99`.
6. **Threshold cutoff** (`engine_set_threshold`, default `0.0` = disabled) — if this step's `n` is below `threshold`, `alpha` is forced to `0` before compositing, letting background/noise be cut out independent of window/level.
7. **Gradient-magnitude opacity modulation** (`engine_set_gradient_opacity_strength`, default `0.0` = no-op) — a scoped-down stand-in for a full 2D transfer function (see §1.4a's note on why). `alpha` is re-weighted by `lerp(1.0, saturate(gradientMagnitude / 2.0), strength)`, suppressing homogeneous-region contributions and emphasizing edges as `strength` increases toward `1.0`.
8. **Mask overlay compositing** — the R8Uint mask texture is sampled via `Load` (nearest); a nonzero class additively composites a fixed highlight color (`(1.0, 0.15, 0.15)`) at alpha 0.6. (Mask on/off and alpha themselves have no UI/export yet — still hardcoded.)
9. **Background composite + jitter + temporal accumulation** — the final `accum` is composited over a fixed background color (`(0.05,0.05,0.12)`) and always returned with alpha=1 (see §1.4). Every frame, the ray's starting offset is jittered per pixel via interleaved gradient noise; while the camera/parameters are static, a `WGPUBlendFactor_Constant` blend accumulates a running average into a persistent buffer to reduce banding. Each new frame's blend weight is `1/(accumFrameIndex+1)`, and `accumFrameIndex` is capped at 31 (so the weight never decays toward zero indefinitely). Accumulation resets (goes dirty) on: `setWindowLevel`, `setColormapPreset`, `setQualityTier`, `setShadingEnabled`, `setExtinction`, `setDensityScale`, `setThreshold`, `setClipBox`, `setGradientOpacityStrength`, `setOcclusionEnabled`, `setCustomColormap`, `orbitCamera`, `zoomCamera`, `resize`, `loadVolume`, `applyMaskSlice`.

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

`RaymarchUBO` (320 bytes, kept byte-synchronized between C++ and Slang via `static_assert(offsetof(...))` on both sides):

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

Both LUT textures (bindings 4 and 5) are regenerated together whenever the colormap preset changes (`setColormapPreset`) — the color ramp plus window/level both change. A window/level-only change does not regenerate either LUT, since the classification curve itself is level-independent.

### 1.7 Temporal accumulation / composite pipeline structure

Orbit3D rendering is now two passes:

1. **Accumulation pass** — `pipeline_` (raymarch) now renders into a persistent, canvas-sized offscreen `accumulationTexture_` (RGBA16Float) instead of the swapchain. If dirty: `loadOp=Clear` + blend weight 1.0 (full overwrite); otherwise: `loadOp=Load` + blend weight `1/(accumFrameIndex+1)`. This indirection exists because the swapchain returns a different physical texture every frame, so accumulating against it directly isn't possible.
2. **Composite pass** — a small separate blit pipeline (`accumulation_blit.slang`, `compositePipeline_`) draws `accumulationTexture_` straight to the swapchain.

`accumulationTexture_` is recreated at the new canvas size every time `resize()` is called.

### 1.8 Color transfer-function presets (REQ-R03)

`engine_set_colormap_preset(presetId)` — `0=Lung, 1=Bone, 2=Soft Tissue (default), 3=Brain`. Each preset carries window/level values plus a low/high RGB color pair; the LUT is a linear gradient between them (the alpha channel is always a plain `t*255` ramp regardless of preset — currently unused by either shader).

| Preset | Center/Width (HU) | Color |
| --- | --- | --- |
| Lung | -600 / 1500 | desaturated navy → pale sky blue |
| Bone | 300 / 1500 | dark brown → ivory |
| Soft Tissue (default) | 40 / 400 | dark red-brown → soft pink |
| Brain | 40 / 80 | dark gray → warm light gray |

A 5th, user-defined **Custom** preset (`engine_set_custom_lut_colors(lowR,G,B, highR,G,B)`, values in `[0,1]`) is layered on top of these four — unlike the fixed presets, it doesn't change window/level, only the color ramp. Not one of `kColormapPresets`' indices; the "Custom" button in the UI is a visual-active-state indicator only (its click doesn't call `engine_set_colormap_preset`), while the two color pickers own actually applying the colors.

### 1.9 Controls exposed in the viewer UI

| Control | Panel section | WASM export |
| --- | --- | --- |
| Window Center / Width (slider + numeric entry) | Window & Level | `engine_set_window_level` |
| 4 preset buttons + Custom (5th, color pickers) | Window & Level | `engine_set_colormap_preset`, `engine_set_custom_lut_colors` |
| View mode (3D Orbit / 2D Slice) | View | `engine_set_view_mode` |
| Axial slice index | View | `engine_set_axial_slice_index` |
| Quality tier (Low/Medium/High) | Rendering | `engine_set_quality_tier` |
| Shading on/off | Rendering | `engine_set_shading_enabled` |
| Extinction / Density Scale / Threshold (slider + numeric entry) | TF Detail | `engine_set_extinction`, `engine_set_density_scale`, `engine_set_threshold` |
| Edge Emphasis (gradient-opacity strength) | TF Detail | `engine_set_gradient_opacity_strength` |
| Occlusion Shading on/off | TF Detail | `engine_set_occlusion_enabled` |
| Clip X/Y/Z min+max sliders, Reset button | Clip | `engine_set_clip_box` |
| Camera orbit/zoom (mouse drag/wheel, not in the panel) | — | `engine_orbit_camera`, `engine_zoom_camera` |

### 1.10 Parameters not yet exposed via UI/export

Light direction / ambient & diffuse shading strength (fixed constants), mask overlay on/off and alpha (fixed at true/0.6), occlusion strength (fixed at full effect when enabled — no slider yet), the color transfer function's second axis as a genuine classification axis (gradient magnitude is only used as an opacity modulator, §1.4a, not a second LUT axis). No further branch is currently planned against this list — pick these up if a concrete need comes up.

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

<!-- Next entry: feat/engine-clinical-shading-controls (§6.4 clipping, §6.2 DOS, §6.3 gradient-magnitude opacity, §5.3 TF detail controls) -->
