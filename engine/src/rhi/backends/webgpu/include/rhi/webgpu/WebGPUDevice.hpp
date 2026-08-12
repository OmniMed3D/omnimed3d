#pragma once

#include "rhi/Device.hpp"

#include <webgpu/webgpu.h>

namespace omnimed3d::rhi::webgpu {

// WebGPU implementation of rhi::Device, targeting the browser canvas via
// Emscripten's emdawnwebgpu port. Verified against the exact struct/callback
// shapes in this repo's installed webgpu.h (emsdk 4.0.10) -- see
// engine/docs/adr/ and claude.md #7 for why that verification mattered here
// (naming has drifted across Dawn/Emscripten versions in the past).
class WebGPUDevice final : public Device {
public:
    void initialize() override;
    bool isReady() const override;
    void renderFrame() override;
    void loadVolume(uint32_t volumeId, void const* data, size_t byteLength,
                     uint32_t width, uint32_t height, uint32_t depth,
                     float spacingX, float spacingY, float spacingZ) override;
    void applyMaskSlice(uint32_t volumeId, uint32_t sliceIndex,
                         uint32_t width, uint32_t height,
                         void const* data, size_t byteLength) override;

private:
    // Signatures match WGPURequestAdapterCallback/WGPURequestDeviceCallback in
    // the emdawnwebgpu port's webgpu.h exactly -- this is the newer
    // CallbackInfo/Future-based Dawn API (message is WGPUStringView, two
    // userdata slots), not the older 4-arg raw-callback style some docs and
    // Mini-Engine-reference still show. Confirmed by reading the actual
    // header the port fetches, not assumed.
    static void onAdapterRequested(WGPURequestAdapterStatus status, WGPUAdapter adapter,
                                    WGPUStringView message, void* userdata1, void* userdata2);
    static void onDeviceRequested(WGPURequestDeviceStatus status, WGPUDevice device,
                                   WGPUStringView message, void* userdata1, void* userdata2);

    void configureSurface();

    WGPUInstance instance_ = nullptr;
    WGPUAdapter adapter_ = nullptr;
    WGPUDevice device_ = nullptr;
    WGPUQueue queue_ = nullptr;
    WGPUSurface surface_ = nullptr;
    bool ready_ = false;

    // Volume/mask state (roadmap step 4). No general RHITexture wrapper --
    // see the Device.hpp header comment for why these stay raw WGPUTexture
    // handles private to this backend for now.
    WGPUTexture volumeTexture_ = nullptr;
    WGPUTexture maskTexture_ = nullptr;
    uint32_t currentVolumeId_ = 0;
    bool hasVolume_ = false;
    uint32_t volumeWidth_ = 0;
    uint32_t volumeHeight_ = 0;
    uint32_t volumeDepth_ = 0;
};

}  // namespace omnimed3d::rhi::webgpu
