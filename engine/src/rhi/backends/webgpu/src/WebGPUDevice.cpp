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

}  // namespace omnimed3d::rhi::webgpu
