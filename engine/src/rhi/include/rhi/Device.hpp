#pragma once

#include <cstddef>
#include <cstdint>

namespace omnimed3d::rhi {

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
    virtual void loadVolume(uint32_t volumeId, void const* data, size_t byteLength,
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
    // panning gap, issue #37): 0 = Orbit3D (default -- the existing
    // REQ-R06 orbit-camera raymarch view), 1 = AxialSlice2D (a real 2D
    // single-slice cross-sectional view, see setAxialSliceIndex). An
    // engine-owned uint32_t enum rather than a string, matching
    // setColormapPreset's own reasoning -- an invalid value is rejected
    // (logged), leaving the current mode unchanged. Safe to call before
    // any volume is loaded -- like setWindowLevel/setColormapPreset, this
    // only stores a plain value consumed by the next renderFrame().
    virtual void setViewMode(uint32_t mode) = 0;

    // Selects the Z slice (raw voxel index, not normalized) the
    // AxialSlice2D view samples. No-op (logged) if no volume is loaded --
    // there is no depth to clamp against yet, mirroring orbitCamera's
    // no-volume no-op. Otherwise clamped to [0, depth-1]. On loadVolume,
    // the engine defaults this to depth/2 (the volume's middle slice).
    virtual void setAxialSliceIndex(uint32_t index) = 0;

    // Selects the raymarch step-count/quality tier (REQ-R04): 0=Low,
    // 1=Medium (default), 2=High. Trades image fidelity (banding, thin-
    // structure visibility) for frame time -- see kQualityTiers in
    // WebGPUDevice.cpp for the concrete step counts. An engine-owned
    // uint32_t enum, matching setViewMode/setColormapPreset's own
    // reasoning. Safe to call before any volume is loaded (stores a plain
    // value consumed by the next renderFrame()); an invalid tier is
    // rejected (logged), leaving the current tier unchanged.
    virtual void setQualityTier(uint32_t tier) = 0;

    // Toggles gradient-based Lambert shading (central-difference density
    // gradient as a pseudo-normal) on the raymarch pass. Off gives the
    // original flat density-only look; on adds depth/form cues from
    // simulated lighting. Safe to call before any volume is loaded, like
    // setQualityTier.
    virtual void setShadingEnabled(bool enabled) = 0;

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
};

}  // namespace omnimed3d::rhi
