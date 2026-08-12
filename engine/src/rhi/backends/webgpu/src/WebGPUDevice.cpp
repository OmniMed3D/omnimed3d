#include "rhi/webgpu/WebGPUDevice.hpp"

#include <cstdio>

namespace omnimed3d::rhi::webgpu {

namespace {
// Fixed for this smoke-test milestone -- resizing/DPR handling is not in
// scope until there's a real application driving canvas size.
constexpr uint32_t kCanvasWidth = 640;
constexpr uint32_t kCanvasHeight = 480;

void logStringView(char const* prefix, WGPUStringView message) {
    if (message.data && message.length > 0) {
        std::printf("%s: %.*s\n", prefix, static_cast<int>(message.length), message.data);
    } else {
        std::printf("%s: (no message)\n", prefix);
    }
}
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
                               float /*spacingX*/, float /*spacingY*/, float /*spacingZ*/) {
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

    currentVolumeId_ = volumeId;
    hasVolume_ = true;
    volumeWidth_ = width;
    volumeHeight_ = height;
    volumeDepth_ = depth;

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

    if (!maskTexture_) {
        // Lazily created on first valid slice -- zero-initialized by WebGPU
        // on creation, so not-yet-written slices read as background/no
        // overlay (PRD #5.3.1) without this code needing to clear it itself.
        WGPUTextureDescriptor desc{};
        desc.dimension = WGPUTextureDimension_3D;
        desc.size = WGPUExtent3D{volumeWidth_, volumeHeight_, volumeDepth_};
        desc.format = WGPUTextureFormat_R8Uint;
        desc.mipLevelCount = 1;
        desc.sampleCount = 1;
        desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        maskTexture_ = wgpuDeviceCreateTexture(device_, &desc);
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

    std::printf("WebGPUDevice::applyMaskSlice: volumeId=%u slice=%u applied\n", volumeId, sliceIndex);
}

}  // namespace omnimed3d::rhi::webgpu
