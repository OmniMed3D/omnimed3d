# Rendering Spec

| Field | Value |
| --- | --- |
| Status | Living document (git-tracked) — every time a rendering-related branch merges, update "1. Current Spec" to reflect the new state and append one row to "2. Change History" |
| Written | 2026-08-20 |
| Last reflects | 2026-08-27 |
| Purpose | One place to see exactly what the engine renders and what's currently tunable, plus a compact record of how each change landed. Originated from `docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md`'s proposals (since deleted — superseded once implemented here or carried into `docs/current/ENGINE_ROADMAP_2026-08-21.md`'s backlog). |

---

## 1. Current Spec

### 1.1 View modes

`engine_set_view_mode(mode)` — `0 = Orbit3D` (default), `1 = Slice2D`, `2 = NativeSlice2D`. Each uses a distinct shader/pipeline and its own UBO struct (`RaymarchUBO` for Orbit3D, `AxialSliceUBO` shared by both Slice2D and NativeSlice2D, see §1.5).

`Slice2D` additionally reads `engine_set_slice_axis(axis)` — `0 = Axial` (fixes Z), `1 = Sagittal` (fixes X), `2 = Coronal` (fixes Y) — against the same canonical-oriented volume `loadVolume()` uploaded. Changing axis resets `engine_set_slice_index`'s value to the middle of the new axis's own valid range. `NativeSlice2D` instead scans a second, independently loaded volume (`engine_load_native_volume` / `engine_set_native_slice_index`) along its own file-order depth — see §1.3.

### 1.2 3D Orbit volume rendering (`volume_raymarch.slang`)

Front-to-back raymarch through an R16Float HU 3D texture. The ray's traversal range (`tNear`/`tFar`) is computed against the **clip box** (§1.4a), not the volume's full AABB — texture sampling coordinates (`uvw`) stay anchored to the full AABB regardless, so clipping only shortens/moves the visible range without touching how the volume or mask textures are sampled. Per step:

1. **Window/level normalization** — clamps raw HU into `[0,1]` as `n`, using `windowCenter`/`windowWidth`. (`engine_set_window_level`, `engine_set_colormap_preset`)
2. **Pre-integrated transfer-function lookup** — samples a 256×256 2D LUT (binding 5) at `(frontN, backN)` to get this step segment's average color (`colorBar`) and average classification value (`sBar`). Compared to a single-point classification, this reduces thin high-contrast structures being missed between steps at low quality tiers (fewer/coarser steps). When `sf==sb` (consecutive steps' `n` values are nearly equal) it converges to the original single-point classification exactly. `sBar` is then scaled by `densityScale` (§1.4a, default `1.0` — no change) before it reaches absorption.
3. **Gradient read** — reads the precomputed gradient volume (binding 6, `gradient_bake.slang`, baked once per `loadVolume()` rather than sampled per raymarch step) trilinearly at this step's `uvw`, then divides by `windowWidth` to convert the stored raw-HU-per-mm value into the same window-normalized-per-mm units the shading/gradient-opacity steps below expect (windowed density `n = (raw-center)/width` is an affine rescaling of raw HU, so its gradient is exactly the raw gradient over `windowWidth`). Shared by shading's normal and gradient-opacity's magnitude below; skipped entirely when neither needs it. **Low-memory mode** (§1.11): `gradientTexture_` is a 1×1×1 dummy (never baked) and this step instead calls `computeGradient()` (forward-difference, 3 extra `volumeTex` samples) — trading ~1.2ms/frame for not allocating the gradient volume's memory (RGBA16Float, 4x the HU volume's own size) at all. `tfParams.z` (UBO) carries this mode's flag.
4. **Gradient-based Lambert shading** (`engine_set_shading_enabled`, a 3-state mode: `0`=off, `1`=on (default), `2`=on-flat, a fixed representative diffuse term used in place of a real gradient read, kept at the engine level for completeness though the viewer doesn't currently select it) — modes 0/1: the gradient from step 3 is used as a pseudo-normal; its N·L term against a fixed world-space light direction (`normalize(0.4,-0.6,0.7)`) multiplies color as `ambient(0.55) + diffuse(0.45)*max(N·L,0)*(1-occlusion*occlusionStrength)`. The gradient is normalized per-axis by the volume's actual voxel spacing (`worldTexelSize`) so its direction isn't skewed on anisotropic volumes. **Directional Occlusion Shading** (optional, `engine_set_occlusion_enabled`, only has an effect when shading is on and not in flat mode) supplies the `occlusion` term: 3 short secondary density samples marching toward the light, averaged into an approximate self-occlusion factor — a cheap stand-in for a full self-shadow ray march.
5. **Beer-Lambert absorption compositing** — `alpha = 1 - exp(-extinction * sBar * stepSize)` (`extinction`, `engine_set_extinction`, default `8.0`), composited front-to-back, early-terminating once `accum.a > 0.99`.
6. **Threshold band cutoff** (`engine_set_threshold` / `engine_set_threshold_max`, defaults `0.0`/`1.0` = disabled) — if this step's `n` is below `threshold` or above `thresholdMax`, `alpha` is forced to `0` before compositing, letting both background/noise and a denser occluding layer be cut out independent of window/level. See §1.4a for per-preset defaults.
7. **Gradient-magnitude opacity modulation** (`engine_set_gradient_opacity_strength`, default `0.0` = no-op) — a scoped-down stand-in for a full 2D transfer function (see §1.4a's note on why). `alpha` is re-weighted by `lerp(1.0, saturate(gradientMagnitude / 2.0), strength)`, suppressing homogeneous-region contributions and emphasizing edges as `strength` increases toward `1.0`.
8. **Mask overlay compositing** — skipped entirely when `engine_set_mask_overlay_enabled` is off (default on); the underlying mask texture is untouched either way, so toggling this back on redisplays already-received mask data with no re-fetch or re-inference. When on, the R8Uint mask texture is sampled via `Load` (nearest) and composites a fixed highlight color (`(1.0, 0.15, 0.15)`) at `engine_set_mask_opacity`'s alpha (default `0.6`), but only once per boundary *crossing* along the ray (previous step's class `== 0` and this step's `!= 0`), not on every step spent inside the mask.
9. **Background composite + jitter + temporal accumulation** — the final `accum` is composited over a configurable background color (`ubo.backgroundColor`, `engine_set_background_color`, default `(0.05,0.05,0.12)`) and always returned with alpha=1 (see §1.7). Every frame, the ray's starting offset is jittered per pixel via interleaved gradient noise; while the camera/parameters are static, a `WGPUBlendFactor_Constant` blend accumulates a running average into a persistent buffer to reduce banding. Each new frame's blend weight is `1/(accumFrameIndex+1)`, capped at 31 (so the weight never decays toward zero indefinitely). Accumulation resets (goes dirty) on: `setWindowLevel`, `setColormapPreset`, `setQualityTier`, `setShadingMode`, `setExtinction`, `setDensityScale`, `setThreshold`, `setThresholdMax`, `setClipBox`, `setGradientOpacityStrength`, `setOcclusionEnabled`, `setCustomColormap`, `orbitCamera`, `zoomCamera`, `resize`, `loadVolume`, `applyMaskSlice`.

### 1.3 2D Slice rendering (`axial_slice.slang`)

Per-pixel sampling of a fixed plane through the *canonical-oriented* volume (`AxialSliceUBO`). After window/level normalization, it looks up the **256×1 1D classification LUT** directly (binding 4, see §1.6) — no pre-integration and no gradient shading apply (a single-plane view has no ray segment to pre-integrate over or shade along). Uses a "contain" letterbox fit so the displayed plane's own physical aspect ratio is preserved regardless of canvas aspect ratio.

**Slice2D** (`sliceAxis` = Axial/Sagittal/Coronal, §1.1) shows the X/Y, Y/Z, or X/Z plane respectively — which pair of `aabbMax_ - aabbMin_`'s components form the displayed (and letterboxed) plane follows the same axis. Mask overlay is composited via `lerp` on this mode only.

**NativeSlice2D** shows a second, independently loaded volume (`engine_load_native_volume`) — the DICOM series' own original per-file slices in their native acquisition order/resolution, as opposed to `loadVolume`'s canonical-LPS-oriented (possibly resampled) volume. Deliberately minimal: no downsampling, no mask overlay (a loaded segmentation mask's geometry only lines up with the canonical volume), no precomputed gradient. Always scans this volume's own Z/depth axis (its "depth" is file order, not necessarily a real spatial axis). No-op (logged) if no volume has ever been loaded via `loadVolume` — this mode reuses that call's LUT/sampler GPU resources and the same `axial_slice.slang` pipeline, bound to a separate bind group (`nativeBindGroup_`) pointing binding 1 at the native volume texture instead, with mask overlay forced off via `maskParams`.

### 1.4 Quality/resolution control (REQ-R04)

`engine_set_quality_tier(tier)` — `0=Low, 1=Medium (default), 2=High`. Per-tier target step count (across the AABB diagonal) and its safety-margin (1.33x) cap:

| Tier | stepsAcrossDiagonal | maxSteps |
| --- | --- | --- |
| Low | 192 | 256 |
| Medium (default) | 384 | 512 |
| High | 768 | 1024 |

**Anisotropic voxel spacing guard**: stepSize is additionally clamped to at most 1.5x the finest of the loaded volume's `spacingX/Y/Z` (`finestSpacing`), and `maxSteps` is grown to compensate so the ray still reaches the far face (final hard cap: 2048 steps). This guard is effectively inert on near-isotropic volumes.

### 1.4a TF detail and clip box controls

TF detail (`engine_set_extinction`, `engine_set_density_scale`, `engine_set_threshold`, `engine_set_threshold_max`, `engine_set_gradient_opacity_strength`, `engine_set_occlusion_enabled`) — see §1.2 steps 2/4/5/6/7 for exactly how each applies. `threshold`/`thresholdMax` form a band (`n < threshold || n > thresholdMax → alpha = 0`); each fixed colormap preset (§1.8) carries its own default band, empirically tuned against real demo CTs in 3D Orbit mode so switching presets doesn't just re-tint the same body-surface silhouette:

| Preset | threshold | thresholdMax |
| --- | --- | --- |
| Lung | 0.25 | 0.45 |
| Bone | 0.40 | 1.0 |
| Soft Tissue, Brain, Mediastinum, Abdomen/Liver, Stroke, Subdural | 0.0 | 1.0 (no band) |

`thresholdMax` is not yet wired to a UI control (§1.10).

Gradient-magnitude opacity modulation is a deliberately scoped-down stand-in for a full 2D transfer function (intensity + gradient magnitude as two LUT axes, Kniss-style): the pre-integrated LUT (§1.6) already uses its second axis for the front/back sample pair, so a genuine second classification axis isn't available without a 3D texture, which wasn't judged worth the complexity yet.

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
tfParams                     x=threshold, y=gradient-opacity strength, z=low-memory gradient fallback (0/1), w=thresholdMax
backgroundColor               xyz=RGB, w=unused -- engine_set_background_color
```

`AxialSliceUBO` (48 bytes) — shared by Slice2D and NativeSlice2D, one 6-entry bind group layout, one `uboBuffer_` sized for the larger of the two structs:

```
sliceParams   x=slice index, y=windowCenter, z=windowWidth, w=sliceAxis (0=Axial/1=Sagittal/2=Coronal; always 0 for NativeSlice2D)
maskParams    x=overlayEnabled (forced 0 for NativeSlice2D), y=overlayAlpha, zw=unused
fitParams     x=fitScaleX, y=fitScaleY (letterbox "contain" fit), zw=unused
```

Clipping, extinction/density-scale/threshold band, gradient-opacity, and DOS only affect the raymarch pipeline — Slice2D/NativeSlice2D don't read any of `RaymarchUBO`'s fields.

### 1.6 Texture bindings (bind group 0)

| Binding | Resource | Notes |
| --- | --- | --- |
| 0 | UBO | RaymarchUBO or AxialSliceUBO |
| 1 | Volume texture (R16Float, 3D) | HU values, trilinear. For NativeSlice2D, `nativeBindGroup_` points this at the separately loaded native volume instead. |
| 2 | Sampler (linear) | Shared by volume + LUT textures |
| 3 | Mask texture (R8Uint, 3D) | `Load` only, never filtered |
| 4 | 1D classification LUT (256×1, RGBA8Unorm) | Sampled directly by the axial shader. Declared but not sampled by the raymarch shader (kept only so both shaders' bind group layouts stay identical) |
| 5 | Pre-integrated LUT (256×256, RGBA8Unorm) | Raymarch shader only. rgb = segment-average color, a = segment-average classification value (sBar) |
| 6 | Gradient texture (RGBA16Float, 3D) | Raymarch shader only, trilinear (same sampler as binding 1). Precomputed raw-HU gradient (`gradient_bake.slang`) — xyz = dHU/d(x,y,z) in HU/mm, baked once per `loadVolume()` by a compute pass rather than sampled per raymarch step. Declared but not sampled by the axial shader, same reasoning as binding 4. In low-memory mode (§1.11) this is a 1×1×1 dummy instead — never baked, never sampled (the shader falls back to `computeGradient()`) |

Both LUT textures (bindings 4 and 5) are regenerated together whenever the colormap preset changes (`setColormapPreset`) — the classification curve plus its (now uniform, §1.8) color ramp both potentially change. A window/level-only change does not regenerate either LUT, since the classification curve itself is level-independent. Binding 6 is only rebaked on `loadVolume()` — window/level changes don't need it either, since it's baked on raw HU rather than windowed density.

### 1.7 Temporal accumulation / composite pipeline structure

Orbit3D rendering is two passes:

1. **Accumulation pass** — `pipeline_` (raymarch) renders into a persistent, canvas-sized offscreen `accumulationTexture_` (RGBA16Float) instead of the swapchain. If dirty: `loadOp=Clear` + blend weight 1.0 (full overwrite); otherwise: `loadOp=Load` + blend weight `1/(accumFrameIndex+1)`. This indirection exists because the swapchain returns a different physical texture every frame, so accumulating against it directly isn't possible.
2. **Composite pass** — a small separate blit pipeline (`accumulation_blit.slang`, `compositePipeline_`) draws `accumulationTexture_` straight to the swapchain.

`accumulationTexture_` is recreated at the new canvas size every time `resize()` is called. Slice2D/NativeSlice2D render directly to the swapchain (single pass, no accumulation — a static per-pixel sample has no banding to reduce).

### 1.8 Color transfer-function presets (REQ-R03)

`engine_set_colormap_preset(presetId)` selects one of 8 fixed clinical window/level + threshold-band presets (table below). As of 2026-08-27, **every fixed preset shares one plain grayscale LUT** (near-black → near-white) rather than a per-preset color tint — real clinical reading screens don't tint CT/MR by window, and the earlier per-preset color ramp was this project's own invention, not a clinical convention. This also made a separately-listed "Grayscale" preset redundant with Soft Tissue (removed — `presetId` 2 is Soft Tissue and the default).

| `presetId` | Preset | Center/Width (HU) |
| --- | --- | --- |
| 0 | Lung | -600 / 1500 |
| 1 | Bone | 300 / 1500 |
| 2 | Soft Tissue (default) | 40 / 400 |
| 3 | Brain | 40 / 80 |
| 4 | Mediastinum | 50 / 350 |
| 5 | Abdomen/Liver | 50 / 400 |
| 6 | Stroke | 32 / 8 (very narrow — early ischemia has only ~1-3 HU of contrast against normal parenchyma) |
| 7 | Subdural | 70 / 200 |

A 9th, user-defined **Custom** entry (`engine_set_custom_lut_colors(lowR,G,B, highR,G,B)`, values in `[0,1]`) is layered on top of these: unlike the fixed presets, it doesn't change window/level or threshold band, only the color ramp (still a linear gradient between the two given colors; alpha stays a plain `t*255` ramp). Not one of `kColormapPresets`' indices — the viewer's preset `<select>` uses `presetId` 8 for it, but the color pickers own actually applying the colors, not `engine_set_colormap_preset`.

The viewer's preset `<select>` also offers a "From File" entry that is **not** an engine colormap preset at all: when the loaded series carries its own DICOM VOI LUT display window (PS3.3 C.11.2), the Shell calls `engine_set_window_level` directly with it, bypassing `engine_set_colormap_preset` entirely (see [`viewer/README.md`](../../viewer/README.md#message-contracts-between-the-pieces)) — a fixed CT-calibrated preset applied to MR data, which isn't in Hounsfield Units at all, can otherwise render as a blown-out white block.

### 1.9 Controls exposed in the viewer UI

| Control | Panel section | WASM export |
| --- | --- | --- |
| Window Center / Width (slider + numeric entry) | Window & Level | `engine_set_window_level` |
| Colormap preset (8 clinical presets + Custom + From File, dropdown) | Window & Level | `engine_set_colormap_preset`, `engine_set_custom_lut_colors` (From File instead calls `engine_set_window_level` directly, viewer-side only — see §1.8) |
| View mode: 3D Orbit / Axial / Sagittal / Coronal / Native | View | `engine_set_view_mode`, `engine_set_slice_axis` (Axial/Sagittal/Coronal share view mode 1, disambiguated by axis) |
| Slice index | View | `engine_set_slice_index` (Slice2D) / `engine_set_native_slice_index` (Native) |
| Quality tier (Low/Medium/High) | Rendering | `engine_set_quality_tier` |
| Shading on/off | Rendering | `engine_set_shading_enabled` |
| Low-Memory Mode (checkbox) + Downsample Factor (2x/4x/8x, shown only when enabled) | Rendering | passed as `engine_load_volume`'s trailing `downsampleFactor` argument — a load-time choice, not a standalone setter (§1.11) |
| Reload Volume (button, enabled once a volume has loaded) | Rendering | re-invokes `engine_load_volume`/`engine_load_native_volume` with the current Low-Memory Mode/Downsample Factor selection — a viewer-side convenience, no new engine export |
| Extinction / Density Scale / Threshold (slider + numeric entry) | TF Detail | `engine_set_extinction`, `engine_set_density_scale`, `engine_set_threshold` |
| Edge Emphasis (gradient-opacity strength) | TF Detail | `engine_set_gradient_opacity_strength` |
| Occlusion Shading on/off | TF Detail | `engine_set_occlusion_enabled` |
| Mask Opacity (slider + numeric entry) | TF Detail | `engine_set_mask_opacity` |
| Show Mask (on/off) | TF Detail | `engine_set_mask_overlay_enabled` |
| Clip X/Y/Z min+max sliders, Reset button | Clip | `engine_set_clip_box` |
| Background color (Dark/Black/Gray/White presets) | Background | `engine_set_background_color` |
| Camera orbit/zoom (mouse drag/wheel, not in the panel) | — | `engine_orbit_camera`, `engine_zoom_camera` |
| GPU Pass / device-lost status (read-only) | Debug | `engine_get_gpu_*_ms`, `engine_get_device_lost*` (§1.12/1.13) |

### 1.10 Parameters not yet exposed via UI/export

Light direction / ambient & diffuse shading strength (fixed constants), occlusion strength (fixed at full effect when enabled — no slider yet), `thresholdMax` (§1.4a — has a real per-preset default but no direct UI control), the color transfer function's second axis as a genuine classification axis (gradient magnitude is only used as an opacity modulator, §1.4a, not a second LUT axis). No further branch is currently planned against this list — pick these up if a concrete need comes up.

### 1.11 Low-memory / downsampled rendering (mobile OOM mitigation)

`engine_load_volume`'s trailing `downsampleFactor` argument (`1` = off; the viewer's checkbox+dropdown offer `2`/`4`/`8`) is a single load-time choice covering two independent memory reductions, picked once per volume load by the caller (the Shell) — the Device has no way to see device memory/UA info itself:

- **Gradient volume skipped** (any `downsampleFactor > 1`) — see §1.2 step 3.
- **In-plane volume/mask downsampling** — the volume and mask 3D textures are shrunk by `downsampleFactor` in X/Y only (depth untouched), nearest-neighbor (not box-averaging: the volume's `uint16_t` buffer is already float16-bit-pattern-encoded upstream, and mask data is discrete class indices where averaging is meaningless). `applyMaskSlice()` validates an incoming slice against the *original* width/height (an AI-Worker slice always arrives at the source DICOM series' resolution) and downsamples it before writing. No shader changes needed — texel/world-space math is derived from the bound texture's actual runtime dimensions.

`NativeSlice2D` (§1.3) is unaffected by any of this — it never downsamples and has no gradient texture to skip.

### 1.12 GPU timing / instrumentation

Feature-detected WebGPU `timestamp-query` (checked on the adapter before requesting the device; included in `requiredFeatures` only if supported — falls back to an explicit "unsupported" state otherwise). A single reused 4-slot `WGPUQuerySet` is wired via each render pass's `timestampWrites`: raymarch + composite passes in Orbit3D, the single Slice2D/NativeSlice2D pass otherwise. `rhi::Device::getGpuTiming()` (+ matching `engine_get_gpu_*_ms` exports) returns the last resolved values — whichever pass-pair didn't run this frame keeps its last measured value rather than resetting to 0.

### 1.13 Robustness controls

- **`engine_set_render_paused(bool)`** — a full early return in `renderFrame()` (no encoder, no GPU submission at all) when paused, so it actually frees the GPU rather than merely skipping compositing. Deliberately does not reset temporal accumulation — resuming continues from where it left off, no flash. Driven by the viewer to relieve GPU contention with concurrent AI inference, gated to Low-Memory Mode volumes only (a full-memory device has no contention problem to relieve).
- **Device-lost / uncaptured-error reporting** — `getDeviceLossState()` is a cheap, side-effect-free snapshot (same polling idiom as `getFrameStats()`/`getHardwareInfo()`) of a real WebGPU device-lost or uncaptured-error event, both registered on the device descriptor at request time. Device loss is permanent once observed (`DeviceLossReason`: `Unknown`/`Destroyed`/`FailedCreation`); an uncaptured error is tracked separately and is dismissible (`clearUncapturedError()`) without implying the device itself is gone. `renderFrame()`'s ready-guard extends to skip once the device is lost.

---

## 2. Change History

Each row is one merged branch/change. Full narrative detail (root-cause diagnoses, real-device measurements, dead ends) lives in the branch's own commits/PR — this table exists to say *what* changed and *when*, not to re-tell the story.

| Date | Branch / change | Summary |
| --- | --- | --- |
| 2026-08-20 | `feat/engine-raymarch-quality` | REQ-R04 quality tiers + anisotropic step-size guard; per-preset color LUTs (later reverted, §1.8); gradient-based Lambert shading; pre-integrated 256×256 LUT; jitter + temporal accumulation (31-frame cap). 2 bugs fixed: accumulation-buffer pipeline built against the wrong color format; unbounded frame counter decaying the blend weight to zero. |
| 2026-08-20 | `feat/engine-clinical-shading-controls` | Clip box; Directional Occlusion Shading; gradient-magnitude opacity modulation (2D-TF stand-in); extinction/density-scale/threshold sliders; a 5th, user-defined Custom colormap. |
| 2026-08-21 | `feat/engine-debug-overlay` | Background color moved from a shader constant to a UBO field/setter; added the perf/hardware stats overlay. |
| 2026-08-21 | `feat/engine-gpu-timestamp-query` | WebGPU `timestamp-query` GPU-pass timing (§1.12). 3 bugs fixed: wrong mapped-buffer accessor for read-mode (`GetConstMappedRange` vs `GetMappedRange`); stale overlay values on view-mode switch; readback started against a buffer still mapped from a previous frame ("used in submit while mapped"). |
| 2026-08-21 | `feat/viewer-mobile-render-perf` | Viewer-only: `<meta viewport>` fix, DPR capped at 1, interaction-adaptive quality tier during camera drag, startup auto-tier. ~8.7x fps improvement on a real iPhone 14 Pro. |
| 2026-08-22 | `feat/viewer-interaction-adaptive-shading` | Viewer-only: shading + occlusion also forced off during camera drag (extends the previous entry's mechanism). |
| 2026-08-22 | `feat/engine-forward-diff-gradient` | `computeGradient()`: central-difference (6 samples) → forward-difference (3 samples, reuses the center sample already read). Real-device measurement: shading's marginal cost -57%. |
| 2026-08-23 | `fix/engine-shading-flat-interaction-mode` | Shading mode `2` ("on-flat", fixed diffuse term, no gradient read) added for interaction-time use; ambient/diffuse rebalanced 0.35/0.65 → 0.55/0.45 (default view was "too dark"). |
| 2026-08-23 | gradient volume precompute | `gradient_bake.slang` compute pass bakes the raw-HU gradient once per `loadVolume()` instead of per raymarch step (§1.2 step 3). Shading's marginal cost: +1.88ms → +0.67ms. Mode 2/interaction-time shading-off dropped from viewer use once the real/flat gap narrowed to ~0.6ms. 2 bugs fixed: default `maxBufferSize` too small for the gradient texture's staging buffer; a Slang `RWTexture3D` compiling to `read_write` where only write access is valid on WebGPU (switched to `WTexture3D`). |
| 2026-08-23 | mask overlay boundary-crossing compositing | Mask highlight now composites once per boundary *crossing* (previous step's class 0 → nonzero) instead of once per step spent inside the mask — fixes a "blurry edge, opaque interior" artifact at low alpha. |
| 2026-08-23 | fix dangling `requiredFeatures` pointer | UB in device request when `timestamp-query` is supported — array's lifetime ended before the request call that read it. |
| 2026-08-23 | mask overlay opacity control + Grayscale default preset | `engine_set_mask_opacity` wired up (the UBO field already existed). Grayscale added as a 5th, default preset (superseded 2026-08-27 — see §1.8). |
| 2026-08-24 | mask overlay show/hide toggle | `engine_set_mask_overlay_enabled` — skips the mask block without touching the mask texture (toggling back on needs no re-fetch/re-inference). Viewer also gained load/segmentation progress gauges (viewer-only). |
| 2026-08-24 | REQ-C03 first parity test | `mask-geometry-parity.spec.ts` — known-answer mask lands in the geometrically correct quadrant (Playwright e2e; no native Vulkan Device exists to run this as a native parity test yet). |
| 2026-08-24 | gradient volume low-memory fallback (Option A) | `lowMemoryMode` (later generalized into `downsampleFactor`, §1.11): skip baking the full gradient volume (266MB for the demo CT), fall back to per-step `computeGradient()`. First step of the mobile-OOM mitigation sequence below. |
| 2026-08-25 | WebGPU device-lost/uncaptured-error handling (Option B) | §1.13 — both callbacks registered at device-request time; viewer shows a reload banner / dismissible toast. |
| 2026-08-25 | pause rendering during AI inference (refined C-2) | §1.13's `setRenderPaused` — relieves GPU command-queue contention with concurrent inference. |
| 2026-08-25 | unload/reload volume textures during inference (Option D) | Added, then **removed same day**: releasing/reloading GPU textures didn't reduce the actual crash-causing peak (a GPU allocator high-water mark, not live residency), and introduced a progress-gauge regression. Not part of the current spec. |
| 2026-08-25 | downsample volume/mask textures in low-memory mode | The actual OOM fix (§1.11) — in-plane nearest-neighbor downsampling, factor tuned 2x → 4x same day via real-device retest, then generalized from a hardcoded constant into the current `downsampleFactor` parameter (1/2/4/8, viewer dropdown). |
| 2026-08-25/26 | gate render-pause to low-memory mode; control-panel progressive disclosure | Viewer-only: render-pause (above) now only engages for a Low-Memory-Mode volume. Control panel reorganized into collapsible `<details>` sections under one "Advanced Mode" toggle, after several rounds of user feedback on which sections should stay always-visible. |
| 2026-08-26 | Low-Memory Mode inference notice; Reload Volume button; concrete quality-tier tooltips | Viewer-only usability pass: a status notice when starting inference under Low-Memory Mode; the Reload Volume control (§1.9 — Low-Memory Mode/Downsample Factor are load-time-only settings, this re-applies them to an already-loaded volume); tier tooltips now state the real step counts (§1.4). |
| 2026-08-26 | fix zero row-gap inside `<details>` sections | Viewer-only CSS fix (`::details-content` needed its own `gap` declaration). |
| 2026-08-27 | MPR + native-slice view modes | `Slice2D` generalized from a fixed axial-only plane to 3 axes (`engine_set_slice_axis`) and a new, independent `NativeSlice2D` mode (`engine_load_native_volume`/`engine_set_native_slice_index`) for the DICOM series' own original per-file slices — §1.1/§1.3. Viewer's single "2D Slice" button became four (Axial/Sagittal/Coronal/Native). |
| 2026-08-27 | clinical preset expansion + grayscale-only LUT | 4 more clinical presets (Mediastinum/Abdomen-Liver/Stroke/Subdural); per-preset threshold/thresholdMax band for Bone and Lung (`engine_set_threshold_max`, new); every fixed preset's color ramp unified to one grayscale LUT, matching a real clinical reading screen (removes the separate Grayscale preset, now redundant with Soft Tissue) — §1.4a/§1.8. Viewer's preset buttons became a `<select>` (9 clinical/Custom entries no longer fit a button row) plus a viewer-only "From File" entry using the series' own DICOM VOI LUT window. |

<!-- Next entry: whatever follow-up comes out of the ~21.7ms fixed-cost investigation flagged in the mobile-render-perf work, once real profiling access exists -->
