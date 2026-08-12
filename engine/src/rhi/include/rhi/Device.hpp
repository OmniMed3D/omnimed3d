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
};

}  // namespace omnimed3d::rhi
