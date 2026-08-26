#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace omnimed3d::rhi {

// Snapshot of the CPU-side frame timer (omnimed3d::utils::FrameStats) at
// the moment getFrameStats() was called. Plain data, not a live handle --
// callers poll this once per stats-panel update rather than holding a
// reference into the backend's own timer state.
struct FrameStatsSnapshot {
    float frameTimeMs = 0.0F;
    float avgFrameTimeMs = 0.0F;
    float fps = 0.0F;
};

// Adapter/device identity strings for a debug/perf overlay (not used for
// any behavioral branching). Backend-agnostic on purpose: WebGPUDevice
// fills this from WGPUAdapterInfo; a future native Vulkan Device would
// fill the same fields from VkPhysicalDeviceProperties instead.
struct HardwareInfo {
    std::string vendor;
    std::string architecture;
    std::string device;
    std::string description;
};

// GPU-side per-pass timing, via WebGPU's optional `timestamp-query` feature
// -- unlike FrameStatsSnapshot (CPU wall-clock, always available), this can
// be unsupported on a given browser/GPU, so `supported` must be checked
// before trusting the *Ms fields (0 either way otherwise). raymarchMs/
// compositeMs are populated in Orbit3D view mode (two passes: raymarch-to-
// accumulation-buffer, then composite-to-swapchain); axialMs in
// AxialSlice2D mode (one pass). Whichever mode isn't active keeps its last
// measured value rather than resetting to 0 -- there's no new measurement
// to overwrite it with on a frame that didn't run that pass.
struct GpuTimingSnapshot {
    bool supported = false;
    float raymarchMs = 0.0F;
    float compositeMs = 0.0F;
    float axialMs = 0.0F;
};

// Backend-agnostic reason for a lost WGPUDevice -- mirrors the shape of
// WGPUDeviceLostReason without leaking that raw Dawn/WebGPU enum across
// this interface (same "backend-agnostic getter" reasoning as
// HardwareInfo above). A future native Vulkan Device would map its own
// device-loss signals (VK_ERROR_DEVICE_LOST) onto this same enum.
enum class DeviceLossReason { None, Unknown, Destroyed, FailedCreation };

// Mobile OOM mitigation: a real WebGPU device-lost or uncaptured-error
// event, surfaced for the Shell to react to (e.g. a "reload the page"
// banner) instead of failing silently. Device loss and an uncaptured
// error are separate, independent facts -- an uncaptured error does not
// necessarily mean the whole device is gone (the WebGPU spec allows an
// app to keep using a device after some uncaptured errors), so this
// struct tracks them as two unrelated fields rather than one combined
// state.
struct DeviceLossSnapshot {
    bool deviceLost = false;
    DeviceLossReason reason = DeviceLossReason::None;
    std::string message;
    bool hasUncapturedError = false;
    std::string uncapturedErrorMessage;
};

// Minimal backend-agnostic seam -- intentionally not a full RHI yet (no
// general Buffer/Pipeline/BindGroup, and loadVolume/applyMaskSlice below
// are named for exactly what they do rather than routed through a generic
// RHITexture type). With only one backend (WebGPU) and no second
// implementation to validate an abstraction's shape against, a general
// cross-backend texture interface would be guessing -- grow this when a
// second backend or a genuinely different resource shape needs it.
class Device {
public:
    virtual ~Device() = default;

    // Dispatches async adapter/device acquisition and returns immediately --
    // callers must poll isReady() before renderFrame(). Deliberately
    // non-blocking: a blocking wait here would need ASYNCIFY, which
    // CLAUDE.md #9 flags as a real trap to avoid where possible.
    virtual void initialize() = 0;

    virtual bool isReady() const = 0;

    // Clears and presents one frame. No-op if !isReady().
    virtual void renderFrame() = 0;

    // Uploads a full HU volume (R16Float) as a new 3D texture, replacing
    // any previously loaded volume and invalidating any mask texture from
    // it (a new volume load means old mask data no longer applies).
    // volumeId is an opaque per-load identifier minted by the caller (the
    // future viewer/-owned orchestration layer, PRD #5.3.2) -- applyMaskSlice
    // uses it to reject stale slices from a previous, already-replaced volume.
    // downsampleFactor: 1 means full resolution; any value > 1 also skips
    // the precomputed gradient volume's memory (a full-volume RGBA16Float
    // texture, 4x the HU volume's own size, trading ~1.2ms/frame of extra
    // shading cost to skip it) and shrinks the volume/mask textures
    // in-plane (X/Y only, depth untouched) by that factor -- intended for
    // memory-constrained devices (mobile OOM mitigation), picked once per
    // load by the caller (this Device has no way to see device memory/UA
    // info itself, which is JS/Shell-only information).
    virtual void loadVolume(uint32_t volumeId, void const* data, size_t byteLength,
                             uint32_t width, uint32_t height, uint32_t depth,
                             float spacingX, float spacingY, float spacingZ, uint32_t downsampleFactor) = 0;

    // Loads a second, independent volume for the NativeSlice2D view mode
    // (MPR/native-slice feature, 2026-08-27 user request) -- the DICOM
    // series' own original per-file slices in their native acquisition
    // order/resolution, as opposed to loadVolume's canonical-LPS-oriented
    // (possibly trilinear-resampled, see the Parse Worker's oblique-series
    // fallback) volume. Deliberately minimal compared to loadVolume: no
    // downsampling, no mask overlay, no precomputed gradient volume --
    // this view exists to let a user look at exactly what the scanner
    // produced, not to support cinematic rendering or AI mask overlay
    // against it (the mask's own geometry only lines up with the
    // canonical-oriented volume). No-op (logged) if no volume has ever
    // been loaded via loadVolume -- this shares that call's LUT/sampler
    // GPU resources rather than duplicating them.
    virtual void loadNativeVolume(uint32_t volumeId, void const* data, size_t byteLength,
                                    uint32_t width, uint32_t height, uint32_t depth,
                                    float spacingX, float spacingY, float spacingZ) = 0;

    // Writes one Z-slice into the mask texture (uint8 class indices, PRD
    // #5.3.1) for the given volume. No-ops (with a logged reason) if
    // volumeId doesn't match the currently loaded volume, or if
    // width/height don't match it -- slices may arrive in any order (PRD
    // #5.3.2), so there is no ordering precondition here.
    virtual void applyMaskSlice(uint32_t volumeId, uint32_t sliceIndex,
                                 uint32_t width, uint32_t height,
                                 void const* data, size_t byteLength) = 0;

    // Clinical window/level applied during raymarch shading (REQ-R03).
    // center/width are in the loaded volume's raw texel units (Hounsfield
    // Units for CT). Safe to call before any volume is loaded -- unlike
    // loadVolume/applyMaskSlice this only stores plain values consumed by
    // the next renderFrame(), no GPU resource dependency to guard against.
    virtual void setWindowLevel(float center, float width) = 0;

    // Selects a baseline window/level + transfer-function-LUT preset
    // (REQ-R03). See ColormapPreset in WebGPUDevice.cpp for the concrete
    // list -- an engine-owned enum, not a string, so an invalid preset
    // can't silently no-op.
    virtual void setColormapPreset(uint32_t presetId) = 0;

    // Interactive orbit camera (REQ-R06). Raw mouse-drag pixel deltas --
    // yaw/pitch accumulate internally (pitch clamped to +-89 degrees, a
    // gimbal-flip guard matching Mini-Engine-reference's validated
    // camera). No-op (logged) if no volume is loaded -- unlike
    // setWindowLevel/setColormapPreset, the zoom clamp this pairs with
    // needs real AABB data, so there is nothing sensible to orbit yet.
    // Also a no-op (logged) when the current view mode is not Orbit3D
    // (see setViewMode) -- the 2D axial slice view has no camera to orbit.
    virtual void orbitCamera(float deltaYawPixels, float deltaPitchPixels) = 0;

    // wheelDeltaSign: pre-normalized by the caller to +-1 per wheel
    // notch (sidesteps real cross-browser/cross-device wheel delta
    // magnitude inconsistency -- DOM_DELTA_PIXEL vs DOM_DELTA_LINE,
    // trackpad vs. mouse wheel -- rather than needing deltaMode-aware
    // normalization logic here). Distance adjusts by an adaptive step
    // (faster when far away already), clamped relative to the loaded
    // volume's own size. No-op (logged) if no volume is loaded, or when
    // the current view mode is not Orbit3D (see setViewMode).
    virtual void zoomCamera(float wheelDeltaSign) = 0;

    // Selects which render pipeline drives renderFrame() (PRD §9 slice-
    // panning gap, issue #37; MPR + native-slice modes added 2026-08-27):
    // 0 = Orbit3D (default -- the existing REQ-R06 orbit-camera raymarch
    // view), 1 = Slice2D (a real 2D single-slice cross-sectional view of
    // the canonical-oriented volume, along whichever axis setSliceAxis
    // selected -- Axial/Sagittal/Coronal, see setSliceIndex/setSliceAxis),
    // 2 = NativeSlice2D (the DICOM series' own original per-file slices,
    // see loadNativeVolume/setNativeSliceIndex). An engine-owned uint32_t
    // enum rather than a string, matching setColormapPreset's own
    // reasoning -- an invalid value is rejected (logged), leaving the
    // current mode unchanged. Safe to call before any volume is loaded --
    // like setWindowLevel/setColormapPreset, this only stores a plain
    // value consumed by the next renderFrame().
    virtual void setViewMode(uint32_t mode) = 0;

    // Selects the slice (raw voxel index, not normalized) the Slice2D view
    // samples, along whichever axis setSliceAxis currently selects. No-op
    // (logged) if no volume is loaded -- there is no dimension to clamp
    // against yet, mirroring orbitCamera's no-volume no-op. Otherwise
    // clamped to [0, dimension-1] for the current axis (depth for Axial,
    // width for Sagittal, height for Coronal). On loadVolume, the engine
    // defaults this to depth/2 (the volume's middle axial slice).
    virtual void setSliceIndex(uint32_t index) = 0;

    // Selects which physical axis the Slice2D view slices along (MPR,
    // 2026-08-27 user request): 0 = Axial (fixes Z, the original single-
    // axis behavior), 1 = Sagittal (fixes X), 2 = Coronal (fixes Y). An
    // invalid value is rejected (logged), leaving the current axis
    // unchanged. Changing axis resets setSliceIndex's value to the middle
    // of the new axis's own valid range (its previous value may be out of
    // range or anatomically meaningless for the new axis). No-op (logged)
    // if no volume is loaded.
    virtual void setSliceAxis(uint32_t axis) = 0;

    // Selects the slice (raw voxel index into loadNativeVolume's own
    // depth, not normalized) the NativeSlice2D view samples -- always
    // scans the native volume's own Z/depth axis (its "depth" is whichever
    // order the DICOM files were assembled in, not necessarily a real
    // spatial axis for a reformatted series), no axis selection needed.
    // No-op (logged) if no native volume is loaded. On loadNativeVolume,
    // the engine defaults this to depth/2.
    virtual void setNativeSliceIndex(uint32_t index) = 0;

    // Selects the raymarch step-count/quality tier (REQ-R04): 0=Low,
    // 1=Medium (default), 2=High. Trades image fidelity (banding, thin-
    // structure visibility) for frame time -- see kQualityTiers in
    // WebGPUDevice.cpp for the concrete step counts. An engine-owned
    // uint32_t enum, matching setViewMode/setColormapPreset's own
    // reasoning. Safe to call before any volume is loaded (stores a plain
    // value consumed by the next renderFrame()); an invalid tier is
    // rejected (logged), leaving the current tier unchanged.
    virtual void setQualityTier(uint32_t tier) = 0;

    // Controls gradient-based Lambert shading on the raymarch pass.
    // 0=off (original flat density-only look), 1=on (default -- adds
    // depth/form cues from simulated lighting via a per-step forward-
    // difference density gradient as a pseudo-normal), 2=on-flat (issue
    // #81: the viewer's interaction-adaptive quality drops to this
    // during a camera drag -- applies the same ambient/diffuse falloff
    // as mode 1 but with a fixed representative diffuse term instead of
    // computing the gradient, so a drag doesn't pay the gradient's
    // sampling cost, the raymarch pass's dominant per-step cost -- but
    // also doesn't cause the jarring brightness jump mode 0 does, since
    // mode 0 skips the ambient/diffuse falloff entirely rather than
    // approximating it). Any other value is rejected (logged), leaving
    // the current mode unchanged. Safe to call before any volume is
    // loaded, like setQualityTier.
    virtual void setShadingMode(uint32_t mode) = 0;

    // Beer-Lambert absorption coefficient for the raymarch pass (was a
    // fixed constant before this control existed). Higher values make the
    // volume look denser/more opaque at the same window/level. Safe to
    // call before any volume is loaded, like setQualityTier.
    virtual void setExtinction(float extinction) = 0;

    // Scales the pre-integrated classification value ("sBar") used for
    // absorption before it reaches the extinction term -- a global
    // density multiplier independent of window/level. 1.0 leaves behavior
    // unchanged from before this control existed.
    virtual void setDensityScale(float scale) = 0;

    // Hard cutoff (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
    // §5.3): normalized density samples below this threshold contribute
    // no opacity, letting background/noise be cut out independently of
    // window/level. In normalized [0,1] units, same space as the
    // window/level-mapped density. 0.0 (default) disables the cutoff
    // entirely.
    virtual void setThreshold(float threshold) = 0;

    // Restricts the raymarch traversal to an axis-aligned sub-box of the
    // loaded volume's world-space AABB (§6.4) -- reveals interior
    // structure without a full MPR view. Values are clamped to stay
    // within the volume's own AABB and min<max per axis; texture sampling
    // coordinates are unaffected (still derived from the full AABB), only
    // the ray's traversal range changes. Reset to the full AABB on every
    // loadVolume() call -- a clip region from a previously loaded
    // (differently sized) volume would otherwise misclip the new one.
    virtual void setClipBox(float minX, float minY, float minZ, float maxX, float maxY, float maxZ) = 0;

    // Scales each raymarch step's opacity by a function of the local
    // density-gradient magnitude (§6.3, a scoped-down stand-in for a full
    // 2D transfer function -- see engine/docs/RENDERING_SPEC.md for why).
    // 0.0 (default) leaves opacity exactly as before; higher values
    // increasingly suppress homogeneous-region noise and emphasize
    // boundaries. Reuses the gradient already computed for shading when
    // shading is enabled.
    virtual void setGradientOpacityStrength(float strength) = 0;

    // Toggles Directional Occlusion Shading (§6.2) -- a handful of short
    // secondary density samples toward the light per raymarch step,
    // approximating self-shadowing far more cheaply than a full
    // self-shadow ray march. Only has a visible effect when shading
    // (setShadingEnabled) is also on, since it modulates the shading
    // pass's diffuse term.
    virtual void setOcclusionEnabled(bool enabled) = 0;

    // Blend strength of the AI segmentation mask highlight color over the
    // volume, in raymarch and axial-slice shading alike (PRD §5.3.1's mask
    // overlay compositor). 0.0 makes the mask invisible; 1.0 fully replaces
    // the underlying volume color where a mask class is present. Clamped to
    // [0,1]. Was a fixed 0.6 constant before this control existed. Safe to
    // call before any volume/mask is loaded, like setQualityTier.
    virtual void setMaskOverlayAlpha(float alpha) = 0;

    // Shows/hides the AI segmentation mask overlay entirely, independent of
    // setMaskOverlayAlpha. The underlying mask texture is untouched either
    // way -- toggling this back on after a volume's mask slices have
    // already arrived redisplays them immediately, with no re-fetch or
    // re-inference needed. Safe to call before any volume/mask is loaded,
    // like setQualityTier.
    virtual void setMaskOverlayEnabled(bool enabled) = 0;

    // Sets a fifth, user-defined colormap (§5.3's "Custom" preset) --
    // low/high RGB in [0,1], distinct from setColormapPreset's fixed
    // 0-3 index range. Does not change window/level (unlike
    // setColormapPreset) -- Custom is purely a color choice layered on
    // whatever window/level is already set.
    virtual void setCustomColormap(float lowR, float lowG, float lowB, float highR, float highG,
                                    float highB) = 0;

    // Raymarch background color (RGB in [0,1], clamped) -- composited by
    // the raymarch shader against whatever the ray didn't hit, and used as
    // the render-pass clear color for the no-volume-loaded and 2D-slice-
    // letterbox cases too, so there's no visible seam between them. Purely
    // cosmetic (unlike setColormapPreset, no clinical window/level meaning
    // attached), so presets live caller-side rather than as an engine-owned
    // enum -- matching setCustomColormap's direct-RGB shape, not
    // setColormapPreset's index shape. Default (0.05, 0.05, 0.12) matches
    // pre-existing behavior for anyone who never touches this control.
    virtual void setBackgroundColor(float r, float g, float b) = 0;

    // Resizes the render surface and recomputes the Orbit3D camera's
    // aspect ratio to match (issue #40 -- the canvas was previously a
    // fixed 640x480 box with no way to reconfigure it). width/height are
    // the canvas's backing-store pixel dimensions (post-devicePixelRatio
    // scaling), not CSS pixels -- the caller (viewer/) owns that
    // conversion via ResizeObserver, matching how orbitCamera/zoomCamera
    // already push caller-normalized values rather than raw browser
    // units. Safe to call before any volume is loaded or before the
    // device is ready -- backends should defer any GPU work until
    // initialize()'s async setup has completed, matching loadVolume's own
    // tolerance for being called at any time.
    virtual void resize(uint32_t width, uint32_t height) = 0;

    // Mobile OOM mitigation: a full early-return from renderFrame() while
    // true -- no encoder, no GPU submission at all -- so the GPU is
    // genuinely free for concurrent work (e.g. AI inference) during the
    // paused window, not just cheaper (a partial "still composite the
    // existing accumulation buffer" pause would still submit GPU work
    // every frame and defeat that purpose). The canvas keeps showing its
    // last-presented frame underneath whatever UI the caller shows during
    // the pause. Deliberately does not reset temporal accumulation state
    // (unlike setQualityTier() and friends) -- resuming continues
    // accumulating from where it left off, with no visual reset/flash.
    virtual void setRenderPaused(bool paused) = 0;

    // Debug/perf overlay support (baseline browser-performance measurement --
    // see engine/tests/wasm_smoke/shell.html's stats panel). Both are cheap,
    // side-effect-free snapshots safe to call every frame from JS-exported
    // getters; neither affects rendering.
    virtual FrameStatsSnapshot getFrameStats() const = 0;
    virtual HardwareInfo getHardwareInfo() const = 0;
    virtual GpuTimingSnapshot getGpuTiming() const = 0;

    // Mobile OOM mitigation: cheap, side-effect-free snapshot of whether
    // the GPU device has been lost or has a pending uncaptured error --
    // same polling pattern as getFrameStats()/getHardwareInfo() above (no
    // EM_ASM/JS-push callback mechanism exists anywhere in this engine,
    // so a getter fits the established idiom rather than introducing one
    // just for this). Once deviceLost is true, it stays true forever
    // (the device handle is genuinely dead); clearUncapturedError() lets
    // the Shell dismiss an uncaptured-error toast without needing to
    // reload, since that half is not necessarily terminal.
    virtual DeviceLossSnapshot getDeviceLossState() const = 0;
    virtual void clearUncapturedError() = 0;
};

}  // namespace omnimed3d::rhi
