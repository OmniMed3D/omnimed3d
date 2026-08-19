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
    void orbitCamera(float deltaYawPixels, float deltaPitchPixels) override;
    void zoomCamera(float wheelDeltaSign) override;
    void setViewMode(uint32_t mode) override;
    void setAxialSliceIndex(uint32_t index) override;
    void resize(uint32_t width, uint32_t height) override;

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

    // Uses canvasWidth_/canvasHeight_ (issue #40) -- called once from
    // onDeviceRequested() with whatever those hold at that point (a
    // placeholder default until resize() is called at least once; the
    // Shell calls it once on startup, see viewer/src/shell/main.ts), and
    // again from resize() itself on every subsequent call.
    void configureSurface();

    // Raymarch pipeline setup -- built once when the device becomes ready,
    // independent of any loaded volume (bind group *layout* is static; the
    // bind group itself, which references specific texture views, is
    // rebuilt per loadVolume() call -- see rebuildBindGroup()). Also builds
    // the axial-slice pipeline (issue #37) -- both pipelines share
    // bindGroupLayout_/pipelineLayout_/uboBuffer_/bindGroup_ unchanged (see
    // createRenderPipelineFor()'s own comment for why that's valid).
    void createPipeline();
    void createSamplerAndLut();
    void rebuildBindGroup();

    // Factors out the blend-state/color-target/pipeline-descriptor
    // boilerplate shared by both render pipelines (issue #37) -- the only
    // difference between the raymarch and axial-slice pipelines is which
    // shader module they run; bindGroupLayout_/pipelineLayout_ are built
    // once by createPipeline() and passed in unchanged. Both shaders
    // declare the exact same 5-entry bind group layout (uniform buffer,
    // volume tex, sampler, mask tex, LUT tex), so one WGPUBindGroup
    // (bindGroup_, referencing uboBuffer_ sized for the larger
    // RaymarchUBO) is valid for whichever pipeline is bound -- WebGPU
    // validates the bound buffer range against each shader's own
    // reflected minimum size, and RaymarchUBO's 224 bytes comfortably
    // covers AxialSliceUBO's 32.
    WGPURenderPipeline createRenderPipelineFor(WGPUShaderModule module);

    // Frames a default camera and world-space AABB from the loaded
    // volume's voxel dimensions + physical spacing, resetting
    // cameraYaw_/cameraPitch_/cameraDistance_ to their defaults. World
    // axes already match the canonical LPS convention the Parse Worker
    // normalizes to upstream (viewer/README.md) -- up=+Z puts
    // patient-Superior at the top of the frame.
    void frameCameraForVolume(uint32_t width, uint32_t height, uint32_t depth,
                               float spacingX, float spacingY, float spacingZ);

    // Recomputes invView_/invProj_ from the current
    // cameraYaw_/cameraPitch_/cameraDistance_ + aabbMin_/aabbMax_ --
    // called after frameCameraForVolume() resets those, and again after
    // orbitCamera()/zoomCamera() update them interactively (REQ-R06).
    void updateCameraMatrices();

    WGPUInstance instance_ = nullptr;
    WGPUAdapter adapter_ = nullptr;
    WGPUDevice device_ = nullptr;
    WGPUQueue queue_ = nullptr;
    WGPUSurface surface_ = nullptr;
    bool ready_ = false;

    // Backing-store pixel dimensions of the render surface (issue #40) --
    // replaces the previous fixed 640x480 constants. Defaulted to a
    // placeholder so configureSurface() has something valid to use even
    // if resize() is never called (shouldn't happen in practice; the
    // Shell always calls it once on startup), and updated by resize().
    uint32_t canvasWidth_ = 640;
    uint32_t canvasHeight_ = 480;

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

    // Axial-slice pipeline (issue #37, PRD §9 slice-panning gap) -- shares
    // bindGroupLayout_/pipelineLayout_/uboBuffer_/bindGroup_ with the
    // raymarch pipeline above; only the shader module and pipeline object
    // differ. See createRenderPipelineFor()'s header comment.
    WGPUShaderModule axialShaderModule_ = nullptr;
    WGPURenderPipeline axialPipeline_ = nullptr;

    // 0 = Orbit3D (default), 1 = AxialSlice2D -- see setViewMode().
    uint32_t viewMode_ = 0;
    // Raw voxel Z index for the AxialSlice2D view -- defaulted to
    // depth/2 on loadVolume(), see setAxialSliceIndex().
    uint32_t axialSliceIndex_ = 0;

    // Camera + AABB. aabbMin_/aabbMax_ and the cameraYaw_/cameraPitch_/
    // cameraDistance_ defaults are (re)framed per loadVolume() call (see
    // frameCameraForVolume()); the latter three are then interactively
    // updated by orbitCamera()/zoomCamera() (REQ-R06) via
    // updateCameraMatrices(), which recomputes invView_/invProj_/
    // cameraPos_ from them.
    glm::mat4 invView_{1.0F};
    glm::mat4 invProj_{1.0F};
    glm::vec3 cameraPos_{0.0F};
    glm::vec3 aabbMin_{0.0F};
    glm::vec3 aabbMax_{0.0F};
    float cameraYaw_ = 0.0F;
    float cameraPitch_ = 0.0F;
    float cameraDistance_ = 0.0F;

    // Window/level + mask overlay parameters -- defaults applied in
    // createPipeline(); overridden via setWindowLevel()/setColormapPreset()
    // or once real data has been observed to have a class present.
    float windowCenter_ = 0.0F;
    float windowWidth_ = 400.0F;
    bool maskOverlayEnabled_ = true;
};

}  // namespace omnimed3d::rhi::webgpu
