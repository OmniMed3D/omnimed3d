#pragma once

#include "rhi/Device.hpp"

#include "core/RenderGraph.hpp"

#include <glm/glm.hpp>
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
    void setWindowLevel(float center, float width) override;
    void setColormapPreset(uint32_t presetId) override;

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

    // Raymarch pipeline setup -- built once when the device becomes ready,
    // independent of any loaded volume (bind group *layout* is static; the
    // bind group itself, which references specific texture views, is
    // rebuilt per loadVolume() call -- see rebuildBindGroup()).
    void createPipeline();
    void createSamplerAndLut();
    void rebuildBindGroup();

    // Auto-frames a default camera and world-space AABB from the loaded
    // volume's voxel dimensions + physical spacing -- no interactive camera
    // controls yet (REQ-R06 / roadmap step 8, separate not-yet-started
    // work), just a fixed, automatically-reasonable view so the raymarch
    // output is visually inspectable. World axes already match the
    // canonical LPS convention the Parse Worker normalizes to upstream
    // (viewer/README.md) -- up=+Z puts patient-Superior at the top of the
    // frame.
    void frameCameraForVolume(uint32_t width, uint32_t height, uint32_t depth,
                               float spacingX, float spacingY, float spacingZ);

    WGPUInstance instance_ = nullptr;
    WGPUAdapter adapter_ = nullptr;
    WGPUDevice device_ = nullptr;
    WGPUQueue queue_ = nullptr;
    WGPUSurface surface_ = nullptr;
    bool ready_ = false;

    // Volume/mask state (roadmap step 4/6). No general RHITexture wrapper --
    // see the Device.hpp header comment for why these stay raw WGPUTexture
    // handles private to this backend for now.
    WGPUTexture volumeTexture_ = nullptr;
    WGPUTexture maskTexture_ = nullptr;
    WGPUTextureView volumeTextureView_ = nullptr;
    WGPUTextureView maskTextureView_ = nullptr;
    uint32_t currentVolumeId_ = 0;
    bool hasVolume_ = false;
    uint32_t volumeWidth_ = 0;
    uint32_t volumeHeight_ = 0;
    uint32_t volumeDepth_ = 0;

    core::RenderGraph renderGraph_;

    // Raymarch pipeline resources -- created once in createPipeline()/
    // createSamplerAndLut() when the device becomes ready.
    WGPUShaderModule shaderModule_ = nullptr;
    WGPUBindGroupLayout bindGroupLayout_ = nullptr;
    WGPUPipelineLayout pipelineLayout_ = nullptr;
    WGPURenderPipeline pipeline_ = nullptr;
    WGPUBuffer uboBuffer_ = nullptr;
    WGPUSampler linearSampler_ = nullptr;
    WGPUTexture lutTexture_ = nullptr;
    WGPUTextureView lutTextureView_ = nullptr;
    // Rebuilt in rebuildBindGroup() -- depends on volumeTextureView_/
    // maskTextureView_, which change every loadVolume() call.
    WGPUBindGroup bindGroup_ = nullptr;

    // Camera + AABB, auto-framed per loadVolume() call -- see
    // frameCameraForVolume().
    glm::mat4 invView_{1.0F};
    glm::mat4 invProj_{1.0F};
    glm::vec3 cameraPos_{0.0F};
    glm::vec3 aabbMin_{0.0F};
    glm::vec3 aabbMax_{0.0F};

    // Window/level + mask overlay parameters -- defaults applied in
    // createPipeline(); overridden via setWindowLevel()/setColormapPreset()
    // or once real data has been observed to have a class present.
    float windowCenter_ = 0.0F;
    float windowWidth_ = 400.0F;
    bool maskOverlayEnabled_ = true;
};

}  // namespace omnimed3d::rhi::webgpu
