#include "rhi/webgpu/WebGPUDevice.hpp"

#include "volume_raymarch.wgsl.hpp"

#include <glm/gtc/matrix_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace omnimed3d::rhi::webgpu {

namespace {
// Fixed for this smoke-test milestone -- resizing/DPR handling is not in
// scope until there's a real application driving canvas size.
constexpr uint32_t kCanvasWidth = 640;
constexpr uint32_t kCanvasHeight = 480;

constexpr uint32_t kLutSize = 256;

// REQ-R06 interactive camera tuning -- rad/px, matching Mini-Engine-
// reference's WASM/mobile-tuned Camera::rotate() sensitivity (this is a
// browser-only target, so their separate native-build constant doesn't
// apply here).
constexpr float kOrbitSensitivity = 0.0025F;

void logStringView(char const* prefix, WGPUStringView message) {
    if (message.data && message.length > 0) {
        std::printf("%s: %.*s\n", prefix, static_cast<int>(message.length), message.data);
    } else {
        std::printf("%s: (no message)\n", prefix);
    }
}

// Mirrors RaymarchUBO in engine/shaders/src/volume_raymarch.slang field for
// field -- every field is a vec4/mat4 specifically to avoid std140 padding
// surprises (CLAUDE.md #8 "UBO-related sizes scattered across 4 places will
// eventually disagree" -- one struct, asserted offsets, matching the
// shader's own std140 layout that Dawn enforces strictly).
struct RaymarchUBO {
    glm::mat4 invView;
    glm::mat4 invProj;
    glm::vec4 cameraPos;
    glm::vec4 aabbMin;
    glm::vec4 aabbMax;
    glm::vec4 rayParams;   // x=stepSize, y=maxSteps, z=extinction, w unused
    glm::vec4 window;      // x=center, y=width, zw unused
    glm::vec4 maskParams;  // x=overlayEnabled, y=overlayAlpha, zw unused
};

static_assert(offsetof(RaymarchUBO, invView) == 0);
static_assert(offsetof(RaymarchUBO, invProj) == 64);
static_assert(offsetof(RaymarchUBO, cameraPos) == 128);
static_assert(offsetof(RaymarchUBO, aabbMin) == 144);
static_assert(offsetof(RaymarchUBO, aabbMax) == 160);
static_assert(offsetof(RaymarchUBO, rayParams) == 176);
static_assert(offsetof(RaymarchUBO, window) == 192);
static_assert(offsetof(RaymarchUBO, maskParams) == 208);
static_assert(sizeof(RaymarchUBO) == 224);

// Baseline clinical window/level presets (REQ-R03) -- values sourced from
// Mini-Engine-reference's medical-volume primer doc, per PRD Appendix A's
// explicit "referencing Mini-Engine's preset values" instruction. All four
// share the same grayscale transfer-function LUT (createSamplerAndLut()) --
// only window/level differs; a colored-per-preset LUT is not needed for
// this pass's DoD (window/level presets, not a colormap gallery) and can be
// added later without re-architecting.
struct ColormapPreset {
    float center;
    float width;
};

constexpr std::array<ColormapPreset, 4> kColormapPresets{{
    {-600.0F, 1500.0F},  // 0: Lung
    {300.0F, 1500.0F},   // 1: Bone
    {40.0F, 400.0F},     // 2: Soft Tissue (default)
    {40.0F, 80.0F},      // 3: Brain
}};
constexpr uint32_t kDefaultColormapPreset = 2;

}  // namespace

void WebGPUDevice::initialize() {
    instance_ = wgpuCreateInstance(nullptr);

    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvasDesc{};
    canvasDesc.chain.sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector;
    canvasDesc.selector = WGPUStringView{"#canvas", WGPU_STRLEN};

    WGPUSurfaceDescriptor surfaceDesc{};
    surfaceDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&canvasDesc);
    surface_ = wgpuInstanceCreateSurface(instance_, &surfaceDesc);

    WGPURequestAdapterCallbackInfo callbackInfo{};
    // AllowSpontaneous is safe here specifically because this engine never
    // uses ASYNCIFY/emscripten_sleep -- CLAUDE.md #9's spontaneous-callback
    // trap is about a spontaneous callback firing while the main stack is
    // suspended inside ASYNCIFY, which cannot happen in this design.
    callbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    callbackInfo.callback = &WebGPUDevice::onAdapterRequested;
    callbackInfo.userdata1 = this;
    wgpuInstanceRequestAdapter(instance_, nullptr, callbackInfo);
}

bool WebGPUDevice::isReady() const {
    return ready_;
}

void WebGPUDevice::onAdapterRequested(WGPURequestAdapterStatus status, WGPUAdapter adapter,
                                       WGPUStringView message, void* userdata1, void* /*userdata2*/) {
    auto* self = static_cast<WebGPUDevice*>(userdata1);
    if (status != WGPURequestAdapterStatus_Success) {
        logStringView("WebGPUDevice: adapter request failed", message);
        return;
    }
    self->adapter_ = adapter;

    WGPURequestDeviceCallbackInfo deviceCallbackInfo{};
    deviceCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    deviceCallbackInfo.callback = &WebGPUDevice::onDeviceRequested;
    deviceCallbackInfo.userdata1 = self;
    wgpuAdapterRequestDevice(adapter, nullptr, deviceCallbackInfo);
}

void WebGPUDevice::onDeviceRequested(WGPURequestDeviceStatus status, WGPUDevice device,
                                      WGPUStringView message, void* userdata1, void* /*userdata2*/) {
    auto* self = static_cast<WebGPUDevice*>(userdata1);
    if (status != WGPURequestDeviceStatus_Success) {
        logStringView("WebGPUDevice: device request failed", message);
        return;
    }
    self->device_ = device;
    self->queue_ = wgpuDeviceGetQueue(device);
    self->configureSurface();
    self->createSamplerAndLut();
    self->createPipeline();
    self->ready_ = true;
}

void WebGPUDevice::configureSurface() {
    WGPUSurfaceConfiguration config{};
    config.device = device_;
    config.format = WGPUTextureFormat_BGRA8Unorm;
    config.usage = WGPUTextureUsage_RenderAttachment;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.width = kCanvasWidth;
    config.height = kCanvasHeight;
    config.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface_, &config);
}

void WebGPUDevice::createSamplerAndLut() {
    WGPUSamplerDescriptor samplerDesc{};
    samplerDesc.magFilter = WGPUFilterMode_Linear;
    samplerDesc.minFilter = WGPUFilterMode_Linear;
    samplerDesc.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    samplerDesc.addressModeU = WGPUAddressMode_ClampToEdge;
    samplerDesc.addressModeV = WGPUAddressMode_ClampToEdge;
    samplerDesc.addressModeW = WGPUAddressMode_ClampToEdge;
    samplerDesc.maxAnisotropy = 1;
    linearSampler_ = wgpuDeviceCreateSampler(device_, &samplerDesc);

    WGPUTextureDescriptor lutDesc{};
    lutDesc.dimension = WGPUTextureDimension_2D;
    lutDesc.size = WGPUExtent3D{kLutSize, 1, 1};
    lutDesc.format = WGPUTextureFormat_RGBA8Unorm;
    lutDesc.mipLevelCount = 1;
    lutDesc.sampleCount = 1;
    lutDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    lutTexture_ = wgpuDeviceCreateTexture(device_, &lutDesc);

    // Grayscale ramp -- r=g=b=a=t. One LUT shared by every colormap preset
    // (only window/level differs between presets today); room to add
    // colored ramps later without touching the bind group shape.
    std::array<uint8_t, kLutSize * 4> lutData{};
    for (uint32_t i = 0; i < kLutSize; ++i) {
        auto const value = static_cast<uint8_t>((i * 255) / (kLutSize - 1));
        lutData[i * 4 + 0] = value;
        lutData[i * 4 + 1] = value;
        lutData[i * 4 + 2] = value;
        lutData[i * 4 + 3] = value;
    }

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = lutTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, 0};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = kLutSize * 4;
    layout.rowsPerImage = 1;

    WGPUExtent3D writeSize{kLutSize, 1, 1};
    wgpuQueueWriteTexture(queue_, &dst, lutData.data(), lutData.size(), &layout, &writeSize);

    WGPUTextureViewDescriptor viewDesc{};
    viewDesc.format = WGPUTextureFormat_RGBA8Unorm;
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.mipLevelCount = 1;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;
    lutTextureView_ = wgpuTextureCreateView(lutTexture_, &viewDesc);

    setColormapPreset(kDefaultColormapPreset);
}

void WebGPUDevice::createPipeline() {
    WGPUShaderModuleDescriptor shaderDesc{};
    WGPUShaderSourceWGSL wgslSource{};
    wgslSource.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgslSource.code = WGPUStringView{kVolumeRaymarchWgsl, WGPU_STRLEN};
    shaderDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&wgslSource);
    shaderModule_ = wgpuDeviceCreateShaderModule(device_, &shaderDesc);

    std::array<WGPUBindGroupLayoutEntry, 5> entries{};
    entries[0].binding = 0;
    entries[0].visibility = WGPUShaderStage_Fragment;
    entries[0].buffer.type = WGPUBufferBindingType_Uniform;

    entries[1].binding = 1;
    entries[1].visibility = WGPUShaderStage_Fragment;
    entries[1].texture.sampleType = WGPUTextureSampleType_Float;
    entries[1].texture.viewDimension = WGPUTextureViewDimension_3D;

    entries[2].binding = 2;
    entries[2].visibility = WGPUShaderStage_Fragment;
    entries[2].sampler.type = WGPUSamplerBindingType_Filtering;

    entries[3].binding = 3;
    entries[3].visibility = WGPUShaderStage_Fragment;
    entries[3].texture.sampleType = WGPUTextureSampleType_Uint;
    entries[3].texture.viewDimension = WGPUTextureViewDimension_3D;

    entries[4].binding = 4;
    entries[4].visibility = WGPUShaderStage_Fragment;
    entries[4].texture.sampleType = WGPUTextureSampleType_Float;
    entries[4].texture.viewDimension = WGPUTextureViewDimension_2D;

    WGPUBindGroupLayoutDescriptor bglDesc{};
    bglDesc.entryCount = entries.size();
    bglDesc.entries = entries.data();
    bindGroupLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &bglDesc);

    WGPUPipelineLayoutDescriptor layoutDesc{};
    layoutDesc.bindGroupLayoutCount = 1;
    layoutDesc.bindGroupLayouts = &bindGroupLayout_;
    pipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &layoutDesc);

    WGPUBlendComponent colorBlend{};
    colorBlend.operation = WGPUBlendOperation_Add;
    colorBlend.srcFactor = WGPUBlendFactor_One;
    colorBlend.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;

    WGPUBlendComponent alphaBlend{};
    alphaBlend.operation = WGPUBlendOperation_Add;
    alphaBlend.srcFactor = WGPUBlendFactor_One;
    alphaBlend.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;

    WGPUBlendState blendState{};
    blendState.color = colorBlend;
    blendState.alpha = alphaBlend;

    WGPUColorTargetState colorTarget{};
    colorTarget.format = WGPUTextureFormat_BGRA8Unorm;
    colorTarget.blend = &blendState;
    colorTarget.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragmentState{};
    fragmentState.module = shaderModule_;
    fragmentState.entryPoint = WGPUStringView{"fragmentMain", WGPU_STRLEN};
    fragmentState.targetCount = 1;
    fragmentState.targets = &colorTarget;

    WGPURenderPipelineDescriptor pipelineDesc{};
    pipelineDesc.layout = pipelineLayout_;
    pipelineDesc.vertex.module = shaderModule_;
    pipelineDesc.vertex.entryPoint = WGPUStringView{"vertexMain", WGPU_STRLEN};
    pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pipelineDesc.primitive.frontFace = WGPUFrontFace_CCW;
    pipelineDesc.primitive.cullMode = WGPUCullMode_None;
    pipelineDesc.multisample.count = 1;
    pipelineDesc.multisample.mask = 0xFFFFFFFF;
    pipelineDesc.fragment = &fragmentState;
    pipeline_ = wgpuDeviceCreateRenderPipeline(device_, &pipelineDesc);

    WGPUBufferDescriptor uboDesc{};
    uboDesc.size = sizeof(RaymarchUBO);
    uboDesc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    uboBuffer_ = wgpuDeviceCreateBuffer(device_, &uboDesc);
}

void WebGPUDevice::frameCameraForVolume(uint32_t width, uint32_t height, uint32_t depth,
                                         float spacingX, float spacingY, float spacingZ) {
    // World-space AABB, centered at the origin, in the same physical
    // millimeter units as spacingX/Y/Z. World axes already match the
    // canonical LPS convention issue #21 established upstream (X=Left,
    // Y=Posterior, Z=Superior) -- see this method's header comment.
    glm::vec3 const halfExtent{
        static_cast<float>(width) * spacingX * 0.5F,
        static_cast<float>(height) * spacingY * 0.5F,
        static_cast<float>(depth) * spacingZ * 0.5F,
    };
    aabbMin_ = -halfExtent;
    aabbMax_ = halfExtent;

    cameraYaw_ = glm::radians(35.0F);
    cameraPitch_ = glm::radians(25.0F);
    cameraDistance_ = glm::length(halfExtent) * 2.5F;

    updateCameraMatrices();
}

void WebGPUDevice::updateCameraMatrices() {
    // Spherical-coordinate orbit camera (yaw/pitch/distance around the
    // AABB's center), matching Mini-Engine-reference's validated
    // Camera::updateCameraVectors(). up=+Z (patient Superior) puts the
    // top of the patient at the top of the frame -- Mini-Engine's own
    // hard-learned lesson ("row 0 = Superior must map to screen top"),
    // applied here to the camera rather than a pixel-row flip since this
    // engine's world axes are already LPS-canonical by the time
    // loadVolume() is called.
    glm::vec3 const eye{
        cameraDistance_ * std::cos(cameraPitch_) * std::sin(cameraYaw_),
        cameraDistance_ * std::cos(cameraPitch_) * std::cos(cameraYaw_) * -1.0F,
        cameraDistance_ * std::sin(cameraPitch_),
    };
    cameraPos_ = eye;

    glm::mat4 const view = glm::lookAt(eye, glm::vec3{0.0F}, glm::vec3{0.0F, 0.0F, 1.0F});
    float const aspect = static_cast<float>(kCanvasWidth) / static_cast<float>(kCanvasHeight);
    glm::mat4 const proj =
        glm::perspective(glm::radians(45.0F), aspect, cameraDistance_ * 0.1F, cameraDistance_ * 3.0F);

    invView_ = glm::inverse(view);
    invProj_ = glm::inverse(proj);
}

void WebGPUDevice::rebuildBindGroup() {
    if (bindGroup_) {
        wgpuBindGroupRelease(bindGroup_);
        bindGroup_ = nullptr;
    }

    std::array<WGPUBindGroupEntry, 5> entries{};
    entries[0].binding = 0;
    entries[0].buffer = uboBuffer_;
    entries[0].offset = 0;
    entries[0].size = sizeof(RaymarchUBO);

    entries[1].binding = 1;
    entries[1].textureView = volumeTextureView_;

    entries[2].binding = 2;
    entries[2].sampler = linearSampler_;

    entries[3].binding = 3;
    entries[3].textureView = maskTextureView_;

    entries[4].binding = 4;
    entries[4].textureView = lutTextureView_;

    WGPUBindGroupDescriptor bgDesc{};
    bgDesc.layout = bindGroupLayout_;
    bgDesc.entryCount = entries.size();
    bgDesc.entries = entries.data();
    bindGroup_ = wgpuDeviceCreateBindGroup(device_, &bgDesc);
}

void WebGPUDevice::renderFrame() {
    if (!ready_) {
        return;
    }

    WGPUSurfaceTexture surfaceTexture{};
    wgpuSurfaceGetCurrentTexture(surface_, &surfaceTexture);
    bool const acquired = surfaceTexture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal ||
                           surfaceTexture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal;
    if (!acquired) {
        return;
    }

    WGPUTextureView view = wgpuTextureCreateView(surfaceTexture.texture, nullptr);
    renderGraph_.transition("swapchain", core::ResourceState::RenderTarget);

    WGPURenderPassColorAttachment colorAttachment{};
    colorAttachment.view = view;
    colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    colorAttachment.loadOp = WGPULoadOp_Clear;
    colorAttachment.storeOp = WGPUStoreOp_Store;
    colorAttachment.clearValue = WGPUColor{0.05, 0.05, 0.12, 1.0};

    WGPURenderPassDescriptor passDesc{};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &colorAttachment;

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);

    if (hasVolume_ && pipeline_ && bindGroup_) {
        renderGraph_.transition("volume", core::ResourceState::ShaderReadOnly);
        renderGraph_.transition("mask", core::ResourceState::ShaderReadOnly);

        glm::vec3 const halfExtent = (aabbMax_ - aabbMin_) * 0.5F;
        float const diagonal = glm::length(halfExtent) * 2.0F;

        RaymarchUBO ubo{};
        ubo.invView = invView_;
        ubo.invProj = invProj_;
        ubo.cameraPos = glm::vec4{cameraPos_, 0.0F};
        ubo.aabbMin = glm::vec4{aabbMin_, 0.0F};
        ubo.aabbMax = glm::vec4{aabbMax_, 0.0F};
        ubo.rayParams = glm::vec4{diagonal / 384.0F, 512.0F, 8.0F, 0.0F};
        ubo.window = glm::vec4{windowCenter_, windowWidth_, 0.0F, 0.0F};
        ubo.maskParams = glm::vec4{maskOverlayEnabled_ ? 1.0F : 0.0F, 0.6F, 0.0F, 0.0F};

        wgpuQueueWriteBuffer(queue_, uboBuffer_, 0, &ubo, sizeof(ubo));

        wgpuRenderPassEncoderSetPipeline(pass, pipeline_);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup_, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    }

    wgpuRenderPassEncoderEnd(pass);

    WGPUCommandBuffer cmdBuffer = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(queue_, 1, &cmdBuffer);

    // No wgpuSurfacePresent call -- unsupported in Emscripten, present
    // happens automatically via requestAnimationFrame under
    // emscripten_set_main_loop (CLAUDE.md #9).
    wgpuCommandBufferRelease(cmdBuffer);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(encoder);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(surfaceTexture.texture);
}

void WebGPUDevice::loadVolume(uint32_t volumeId, void const* data, size_t byteLength,
                               uint32_t width, uint32_t height, uint32_t depth,
                               float spacingX, float spacingY, float spacingZ) {
    if (!ready_) {
        std::printf("WebGPUDevice::loadVolume: device not ready, ignoring\n");
        return;
    }
    size_t const expected = static_cast<size_t>(width) * height * depth * sizeof(uint16_t);
    if (byteLength != expected) {
        std::printf("WebGPUDevice::loadVolume: byteLength %zu != expected %zu, ignoring\n", byteLength,
                     expected);
        return;
    }

    // A new volume load invalidates any mask texture from the previous
    // volume -- old mask data no longer applies (PRD #5.3.2).
    if (volumeTextureView_) {
        wgpuTextureViewRelease(volumeTextureView_);
        volumeTextureView_ = nullptr;
    }
    if (maskTextureView_) {
        wgpuTextureViewRelease(maskTextureView_);
        maskTextureView_ = nullptr;
    }
    if (maskTexture_) {
        wgpuTextureRelease(maskTexture_);
        maskTexture_ = nullptr;
    }
    if (volumeTexture_) {
        wgpuTextureRelease(volumeTexture_);
        volumeTexture_ = nullptr;
    }

    WGPUTextureDescriptor desc{};
    desc.dimension = WGPUTextureDimension_3D;
    desc.size = WGPUExtent3D{width, height, depth};
    desc.format = WGPUTextureFormat_R16Float;
    desc.mipLevelCount = 1;
    desc.sampleCount = 1;
    desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    volumeTexture_ = wgpuDeviceCreateTexture(device_, &desc);

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = volumeTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, 0};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = width * static_cast<uint32_t>(sizeof(uint16_t));
    layout.rowsPerImage = height;

    WGPUExtent3D writeSize{width, height, depth};
    wgpuQueueWriteTexture(queue_, &dst, data, byteLength, &layout, &writeSize);
    renderGraph_.transition("volume", core::ResourceState::TransferDst);

    // Mask texture is created here (not lazily on the first applyMaskSlice
    // call, as an earlier version of this code did) so the raymarch bind
    // group always has a valid mask texture view to reference, even before
    // any segmentation slice has arrived -- PRD #5.3.2's decoupling model
    // ("the volume renders immediately, mask overlay fills in as slices
    // arrive") requires the volume to be drawable on its own. WebGPU
    // zero-initializes new textures, so an all-background (class 0) mask
    // is already the correct initial state without this code clearing it
    // itself -- same property the old lazy-creation comment relied on.
    WGPUTextureDescriptor maskDesc{};
    maskDesc.dimension = WGPUTextureDimension_3D;
    maskDesc.size = WGPUExtent3D{width, height, depth};
    maskDesc.format = WGPUTextureFormat_R8Uint;
    maskDesc.mipLevelCount = 1;
    maskDesc.sampleCount = 1;
    maskDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    maskTexture_ = wgpuDeviceCreateTexture(device_, &maskDesc);
    renderGraph_.transition("mask", core::ResourceState::TransferDst);

    WGPUTextureViewDescriptor volumeViewDesc{};
    volumeViewDesc.format = WGPUTextureFormat_R16Float;
    volumeViewDesc.dimension = WGPUTextureViewDimension_3D;
    volumeViewDesc.mipLevelCount = 1;
    volumeViewDesc.arrayLayerCount = 1;
    volumeViewDesc.aspect = WGPUTextureAspect_All;
    volumeTextureView_ = wgpuTextureCreateView(volumeTexture_, &volumeViewDesc);

    WGPUTextureViewDescriptor maskViewDesc{};
    maskViewDesc.format = WGPUTextureFormat_R8Uint;
    maskViewDesc.dimension = WGPUTextureViewDimension_3D;
    maskViewDesc.mipLevelCount = 1;
    maskViewDesc.arrayLayerCount = 1;
    maskViewDesc.aspect = WGPUTextureAspect_All;
    maskTextureView_ = wgpuTextureCreateView(maskTexture_, &maskViewDesc);

    currentVolumeId_ = volumeId;
    hasVolume_ = true;
    volumeWidth_ = width;
    volumeHeight_ = height;
    volumeDepth_ = depth;

    frameCameraForVolume(width, height, depth, spacingX, spacingY, spacingZ);
    rebuildBindGroup();

    std::printf("WebGPUDevice::loadVolume: volumeId=%u %ux%ux%u loaded\n", volumeId, width, height, depth);
}

void WebGPUDevice::applyMaskSlice(uint32_t volumeId, uint32_t sliceIndex, uint32_t width, uint32_t height,
                                   void const* data, size_t byteLength) {
    if (!hasVolume_ || volumeId != currentVolumeId_) {
        std::printf("WebGPUDevice::applyMaskSlice: stale volumeId=%u (current=%u), ignoring\n", volumeId,
                     currentVolumeId_);
        return;
    }
    if (width != volumeWidth_ || height != volumeHeight_) {
        std::printf("WebGPUDevice::applyMaskSlice: %ux%u doesn't match loaded volume %ux%u, ignoring\n",
                     width, height, volumeWidth_, volumeHeight_);
        return;
    }
    if (sliceIndex >= volumeDepth_) {
        std::printf("WebGPUDevice::applyMaskSlice: sliceIndex %u out of range (depth=%u), ignoring\n",
                     sliceIndex, volumeDepth_);
        return;
    }
    size_t const expected = static_cast<size_t>(width) * height * sizeof(uint8_t);
    if (byteLength != expected) {
        std::printf("WebGPUDevice::applyMaskSlice: byteLength %zu != expected %zu, ignoring\n", byteLength,
                     expected);
        return;
    }

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = maskTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, sliceIndex};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = width * static_cast<uint32_t>(sizeof(uint8_t));
    layout.rowsPerImage = height;

    WGPUExtent3D writeSize{width, height, 1};
    wgpuQueueWriteTexture(queue_, &dst, data, byteLength, &layout, &writeSize);
    renderGraph_.transition("mask", core::ResourceState::TransferDst);

    std::printf("WebGPUDevice::applyMaskSlice: volumeId=%u slice=%u applied\n", volumeId, sliceIndex);
}

void WebGPUDevice::setWindowLevel(float center, float width) {
    windowCenter_ = center;
    windowWidth_ = width;
}

void WebGPUDevice::setColormapPreset(uint32_t presetId) {
    if (presetId >= kColormapPresets.size()) {
        std::printf("WebGPUDevice::setColormapPreset: invalid presetId=%u (max %zu), ignoring\n", presetId,
                     kColormapPresets.size() - 1);
        return;
    }
    ColormapPreset const& preset = kColormapPresets[presetId];
    windowCenter_ = preset.center;
    windowWidth_ = preset.width;
}

void WebGPUDevice::orbitCamera(float deltaYawPixels, float deltaPitchPixels) {
    if (!hasVolume_) {
        std::printf("WebGPUDevice::orbitCamera: no volume loaded, ignoring\n");
        return;
    }

    cameraYaw_ -= deltaYawPixels * kOrbitSensitivity;
    cameraPitch_ -= deltaPitchPixels * kOrbitSensitivity;
    // Gimbal-flip guard -- yaw is intentionally left unclamped (free spin).
    cameraPitch_ = std::clamp(cameraPitch_, glm::radians(-89.0F), glm::radians(89.0F));

    updateCameraMatrices();
}

void WebGPUDevice::zoomCamera(float wheelDeltaSign) {
    if (!hasVolume_) {
        std::printf("WebGPUDevice::zoomCamera: no volume loaded, ignoring\n");
        return;
    }

    glm::vec3 const halfExtent = (aabbMax_ - aabbMin_) * 0.5F;
    float const extent = glm::length(halfExtent);

    // Adaptive step (faster when already far away, via cameraDistance_'s
    // own contribution), matching Mini-Engine-reference's Camera::zoom()
    // -- but with a floor relative to this volume's own size rather than
    // their fixed absolute 1.5, since world units here are physical mm
    // and vary per volume.
    float const zoomSpeed = std::max(extent * 0.05F, cameraDistance_ * 0.08F);
    cameraDistance_ -= wheelDeltaSign * zoomSpeed;
    cameraDistance_ = std::clamp(cameraDistance_, extent * 0.3F, extent * 10.0F);

    updateCameraMatrices();
}

}  // namespace omnimed3d::rhi::webgpu
