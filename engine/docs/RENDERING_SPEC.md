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

Front-to-back raymarch through an R16Float HU 3D texture. Per step:

1. **Window/level normalization** — clamps raw HU into `[0,1]` as `n`, using `windowCenter`/`windowWidth`. (`engine_set_window_level`, `engine_set_colormap_preset`)
2. **Pre-integrated transfer-function lookup** — samples a 256×256 2D LUT (binding 5) at `(frontN, backN)` to get this step segment's average color (`colorBar`) and average classification value (`sBar`). Compared to the previous single-point classification, this reduces thin high-contrast structures being missed between steps at low quality tiers (fewer/coarser steps). When `sf==sb` (consecutive steps' `n` values are nearly equal) it converges to the original single-point classification exactly.
3. **Gradient-based Lambert shading** (optional, `engine_set_shading_enabled`) — a central-difference density gradient is used as a pseudo-normal; its N·L term against a fixed world-space light direction (`normalize(0.4,-0.6,0.7)`) multiplies color as `ambient(0.35) + diffuse(0.65)*max(N·L,0)`. The gradient is normalized per-axis by the volume's actual voxel spacing (`worldTexelSize`) so its direction isn't skewed on anisotropic volumes.
4. **Beer-Lambert absorption compositing** — `alpha = 1 - exp(-extinction * sBar * stepSize)` (`extinction` currently fixed at `8.0`), composited front-to-back, early-terminating once `accum.a > 0.99`.
5. **Mask overlay compositing** — the R8Uint mask texture is sampled via `Load` (nearest); a nonzero class additively composites a fixed highlight color (`(1.0, 0.15, 0.15)`) at alpha 0.6. (Mask on/off and alpha themselves have no UI/export yet — still hardcoded.)
6. **Background composite + jitter + temporal accumulation** — the final `accum` is composited over a fixed background color (`(0.05,0.05,0.12)`) and always returned with alpha=1 (see §1.4). Every frame, the ray's starting offset is jittered per pixel via interleaved gradient noise; while the camera/parameters are static, a `WGPUBlendFactor_Constant` blend accumulates a running average into a persistent buffer to reduce banding. Each new frame's blend weight is `1/(accumFrameIndex+1)`, and `accumFrameIndex` is capped at 31 (so the weight never decays toward zero indefinitely). Accumulation resets (goes dirty) on: `setWindowLevel`, `setColormapPreset`, `setQualityTier`, `setShadingEnabled`, `orbitCamera`, `zoomCamera`, `resize`, `loadVolume`, `applyMaskSlice`.

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

### 1.5 UBO layout

`RaymarchUBO` (256 bytes, kept byte-synchronized between C++ and Slang via `static_assert(offsetof(...))` on both sides):

```
invView, invProj             mat4 x2
cameraPos, aabbMin, aabbMax  vec4 x3 (world mm)
rayParams                    x=stepSize, y=maxSteps, z=extinction, w=unused
window                       x=center, y=width, zw=unused
maskParams                   x=overlayEnabled, y=overlayAlpha, zw=unused
shadingParams                xyz=light direction, w=shading enabled (0/1)
jitterParams                 x=accumFrameIndex, y=accumulation enabled (reserved, always 1), zw=unused
```

`AxialSliceUBO` (48 bytes) — `sliceParams`/`maskParams`/`fitParams`. Both structs share one `uboBuffer_` (sized for the larger of the two) and one 6-entry bind group layout.

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

### 1.9 Controls exposed in the viewer UI

| Control | Panel section | WASM export |
| --- | --- | --- |
| Window Center / Width (slider + numeric entry) | Window & Level | `engine_set_window_level` |
| 4 preset buttons | Window & Level | `engine_set_colormap_preset` |
| View mode (3D Orbit / 2D Slice) | View | `engine_set_view_mode` |
| Axial slice index | View | `engine_set_axial_slice_index` |
| Quality tier (Low/Medium/High) | Rendering | `engine_set_quality_tier` |
| Shading on/off | Rendering | `engine_set_shading_enabled` |
| Camera orbit/zoom (mouse drag/wheel, not in the panel) | — | `engine_orbit_camera`, `engine_zoom_camera` |

### 1.10 Parameters not yet exposed via UI/export

Extinction coefficient (fixed at 8.0), light direction / ambient & diffuse strength (fixed), mask overlay on/off and alpha (fixed at true/0.6), density scale, threshold, clipping region, the color transfer function's second axis (gradient magnitude). Targeted for the next branch (`feat/engine-clinical-shading-controls`).

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
