#include "rhi/webgpu/WebGPUDevice.hpp"

#include "accumulation_blit.wgsl.hpp"
#include "axial_slice.wgsl.hpp"
#include "gradient_bake.wgsl.hpp"
#include "volume_raymarch.wgsl.hpp"

#include <glm/gtc/matrix_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace omnimed3d::rhi::webgpu {

namespace {
constexpr uint32_t kLutSize = 256;

// Pre-integrated (front,back) transfer-function table -- see
// writePreintegratedLutColors()'s header comment for the bake algorithm.
constexpr uint32_t kPreintegratedLutSize = 256;
constexpr uint32_t kPreintegrationSubSamples = 16;

// REQ-R06 interactive camera tuning -- rad/px, tuned for a WASM/mobile
// browser target.
constexpr float kOrbitSensitivity = 0.0025F;

// Nearest-neighbor subsample of a WxHxD (or single-slice, D=1) buffer to
// (ceil(W/factor))x(ceil(H/factor))xD, in place of box-averaging: the
// volume's uint16_t buffer is already float16-bit-pattern-encoded
// upstream, so treating it as an opaque value and picking one texel per
// block needs no float16 codec here, whereas averaging would. Mask data
// (uint8_t) is discrete class indices (REQ-C01), where averaging labels
// is meaningless -- nearest-neighbor is the correct choice there anyway.
// Ceiling division on the output extent handles odd input dimensions;
// the source-index clamp guards the last output row/column when
// width/height isn't an exact multiple of factor.
template <typename T>
std::vector<T> downsampleNearestXY(T const* src, uint32_t width, uint32_t height, uint32_t depth, uint32_t factor,
                                    uint32_t& outWidth, uint32_t& outHeight) {
    outWidth = (width + factor - 1) / factor;
    outHeight = (height + factor - 1) / factor;
    std::vector<T> out(static_cast<size_t>(outWidth) * outHeight * depth);
    for (uint32_t z = 0; z < depth; z++) {
        for (uint32_t y = 0; y < outHeight; y++) {
            uint32_t const sy = std::min(y * factor, height - 1);
            for (uint32_t x = 0; x < outWidth; x++) {
                uint32_t const sx = std::min(x * factor, width - 1);
                out[(static_cast<size_t>(z) * outHeight + y) * outWidth + x] =
                    src[(static_cast<size_t>(z) * height + sy) * width + sx];
            }
        }
    }
    return out;
}

void logStringView(char const* prefix, WGPUStringView message) {
    if (message.data && message.length > 0) {
        std::printf("%s: %.*s\n", prefix, static_cast<int>(message.length), message.data);
    } else {
        std::printf("%s: (no message)\n", prefix);
    }
}

// Mobile OOM mitigation -- onDeviceLost()/onUncapturedError() need to
// retain the message past the callback's own lifetime (for
// getDeviceLossState()'s later poll), unlike logStringView() above's
// fire-and-forget console print.
std::string stringViewToStdString(WGPUStringView view) {
    return (view.data && view.length > 0) ? std::string(view.data, view.length) : std::string();
}

// Mirrors RaymarchUBO in engine/shaders/src/volume_raymarch.slang field
// for field -- every field is a vec4/mat4 specifically to avoid std140
// padding surprises. One struct with asserted offsets, matching the
// shader's own std140 layout that Dawn enforces strictly.
struct RaymarchUBO {
    glm::mat4 invView;
    glm::mat4 invProj;
    glm::vec4 cameraPos;
    glm::vec4 aabbMin;
    glm::vec4 aabbMax;
    glm::vec4 rayParams;      // x=stepSize, y=maxSteps, z=extinction, w unused
    glm::vec4 window;         // x=center, y=width, zw unused
    glm::vec4 maskParams;     // x=overlayEnabled, y=overlayAlpha, zw unused
    glm::vec4 shadingParams;    // xyz=light direction (world, normalized), w=shading mode (0=off, 1=on, 2=on-flat)
    glm::vec4 jitterParams;     // x=accumFrameIndex, y=accumulation enabled (0/1), zw unused
    glm::vec4 clipMin;          // xyz, world mm -- raymarch traversal bound
    glm::vec4 clipMax;          // xyz, world mm -- raymarch traversal bound
    glm::vec4 occlusionParams;  // x=DOS enabled (0/1), y=strength, zw unused
    glm::vec4 tfParams;         // x=threshold, y=gradient-opacity strength, z=low-memory gradient fallback (0/1),
                                // w=thresholdMax (upper cutoff)
    glm::vec4 backgroundColor;  // xyz=RGB, w unused -- see setBackgroundColor()
};

static_assert(offsetof(RaymarchUBO, invView) == 0);
static_assert(offsetof(RaymarchUBO, invProj) == 64);
static_assert(offsetof(RaymarchUBO, cameraPos) == 128);
static_assert(offsetof(RaymarchUBO, aabbMin) == 144);
static_assert(offsetof(RaymarchUBO, aabbMax) == 160);
static_assert(offsetof(RaymarchUBO, rayParams) == 176);
static_assert(offsetof(RaymarchUBO, window) == 192);
static_assert(offsetof(RaymarchUBO, maskParams) == 208);
static_assert(offsetof(RaymarchUBO, shadingParams) == 224);
static_assert(offsetof(RaymarchUBO, jitterParams) == 240);
static_assert(offsetof(RaymarchUBO, clipMin) == 256);
static_assert(offsetof(RaymarchUBO, clipMax) == 272);
static_assert(offsetof(RaymarchUBO, occlusionParams) == 288);
static_assert(offsetof(RaymarchUBO, tfParams) == 304);
static_assert(offsetof(RaymarchUBO, backgroundColor) == 320);
static_assert(sizeof(RaymarchUBO) == 336);

// Mirrors AxialSliceUBO in engine/shaders/src/axial_slice.slang --
// deliberately a separate, smaller struct rather than reusing RaymarchUBO:
// the 2D slice view needs no camera/AABB/ray-march fields.
struct AxialSliceUBO {
    // w=sliceAxis (MPR: 0=Axial/fixes Z, 1=Sagittal/fixes X,
    // 2=Coronal/fixes Y -- always 0 for the NativeSlice2D view, which has
    // no axis concept of its own, see loadNativeVolume's header comment).
    glm::vec4 sliceParams;  // x=sliceIndex (raw voxel index), y=windowCenter, z=windowWidth, w=sliceAxis
    glm::vec4 maskParams;   // x=overlayEnabled, y=overlayAlpha, zw unused
    // "Contain" letterbox fit -- see axial_slice.slang's own comment on
    // this field for the full rationale. x/y are NDC scale factors,
    // computed fresh every frame in renderFrame() from the volume's
    // physical aspect ratio (aabbMax_ - aabbMin_) vs.
    // canvasWidth_/canvasHeight_'s aspect ratio.
    glm::vec4 fitParams;
};

static_assert(offsetof(AxialSliceUBO, sliceParams) == 0);
static_assert(offsetof(AxialSliceUBO, maskParams) == 16);
static_assert(offsetof(AxialSliceUBO, fitParams) == 32);
static_assert(sizeof(AxialSliceUBO) == 48);

// View modes for WebGPUDevice::setViewMode().
constexpr uint32_t kViewModeOrbit3D = 0;
constexpr uint32_t kViewModeSlice2D = 1;
constexpr uint32_t kViewModeNativeSlice2D = 2;

// Slice axes for WebGPUDevice::setSliceAxis() (MPR).
constexpr uint32_t kSliceAxisAxial = 0;
constexpr uint32_t kSliceAxisSagittal = 1;
constexpr uint32_t kSliceAxisCoronal = 2;

// Every fixed preset shares one plain grayscale LUT (kGrayscaleLow/High
// below) -- clinical reading screens don't tint by window, so there is no
// per-preset color ramp; only the "Custom" preset carries user-chosen
// colors, applied through setCustomColormap()/writeLutColors() directly.
//
// Baseline clinical window/level presets (REQ-R03) -- center/width values
// per PRD Appendix A; the four added later (Mediastinum/Abdomen-Liver/
// Stroke/Subdural) come from standard radiology window/level references.
struct ColormapPreset {
    float center;
    float width;
    // Per-preset default threshold band (volume_raymarch.slang's
    // `n < threshold || n > thresholdMax -> alpha = 0` cutoff), applied
    // by setColormapPreset() below. Empirically tuned (screenshot
    // comparison) against the LIDC-IDRI demo CTs in 3D Orbit mode --
    // without it, every preset saturated to opaque at the skin/fat
    // surface before the ray reached the tissue the preset is named for.
    //
    // Bone: skin/fat sit at n~0.3, bone at n>=0.4 within Bone's window --
    // threshold=0.4 cuts skin while keeping bone. No upper cutoff needed.
    //
    // Lung: needs both ends of the band. Its window floor is far enough
    // below real background air that air itself isn't fully cut, so the
    // ray saturates to opaque from background air before reaching the
    // patient; threshold=0.25 (raw HU ~ -975) cuts that out. thresholdMax
    // then cuts the denser chest wall in front of the lung; it was
    // narrowed to 0.45 (raw HU ~ -825) so a loaded lungmask R231 mask
    // deep in the parenchyma stays visible. This improves the "solid
    // cylinder"/invisible-mask symptoms but does not produce a textbook
    // two-lung-fields silhouette from every outside angle -- a ray
    // through the thick lateral chest wall still saturates first. A full
    // fix is a transfer-function-shape problem; Clip box is the current
    // workaround for looking inside.
    //
    // Brain and the four later presets are left at threshold=0.0,
    // thresholdMax=1.0 -- none of this repo's demo CTs give real 3D-Orbit
    // tuning data for them, and a guessed value would just repeat the
    // failure mode the tuned values above were found to avoid.
    float threshold;
    float thresholdMax;
};

constexpr std::array<ColormapPreset, 8> kColormapPresets{{
    {-600.0F, 1500.0F, 0.25F, 0.45F},  // 0: Lung
    {300.0F, 1500.0F, 0.4F, 1.0F},     // 1: Bone
    {40.0F, 400.0F, 0.0F, 1.0F},       // 2: Soft Tissue (default)
    {40.0F, 80.0F, 0.0F, 1.0F},        // 3: Brain
    {50.0F, 350.0F, 0.0F, 1.0F},       // 4: Mediastinum
    {50.0F, 400.0F, 0.0F, 1.0F},       // 5: Abdomen/Liver
    {32.0F, 8.0F, 0.0F, 1.0F},         // 6: Stroke (very narrow window -- early ischemia has only
                                       // ~1-3 HU of contrast against normal parenchyma)
    {70.0F, 200.0F, 0.0F, 1.0F},       // 7: Subdural
}};
constexpr uint32_t kDefaultColormapPreset = 2;  // Soft Tissue

// The grayscale ramp every fixed preset shares. Only hue is fixed here;
// opacity still comes from writePreintegratedLutColors()'s shape(s)=s.
constexpr ColorRGB kGrayscaleLow{12, 12, 12};
constexpr ColorRGB kGrayscaleHigh{245, 245, 245};

// REQ-R04 quality/step-count tiers -- WebGPUDevice::setQualityTier().
// stepsAcrossDiagonal sizes stepSize (diagonal / this); maxSteps is a
// 1.33x safety-margin multiple of that so grazing rays that need more
// than "diagonal / stepSize" steps still traverse the full box before
// hitting the loop's own cap.
struct QualityTier {
    float stepsAcrossDiagonal;
    float maxSteps;
};

constexpr std::array<QualityTier, 3> kQualityTiers{{
    {192.0F, 256.0F},   // 0: Low
    {384.0F, 512.0F},   // 1: Medium (default)
    {768.0F, 1024.0F},  // 2: High
}};
constexpr uint32_t kDefaultQualityTier = 1;

// Fixed world-space light direction for gradient-based Lambert shading
// (setShadingMode()) -- a camera-independent key light (not exposed as a
// setter; ambient/diffuse strength are likewise fixed constants in the
// shader). Chosen off-axis from the default camera framing
// (frameCameraForVolume()'s 35deg yaw / 25deg pitch) so shaded volumes
// show visible form from the default view, not a flat silhouette.
const glm::vec3 kLightDirection = glm::normalize(glm::vec3{0.4F, -0.6F, 0.7F});

// Anisotropic-spacing step-size guard: the raymarch step size is
// otherwise isotropic in world mm (derived from the AABB diagonal),
// which can undersample a volume's finest axis on thick-slice/anisotropic
// data. Clamping stepSize to at most 1.5x the finest axis's physical
// spacing keeps thin structures along that axis from being stepped over
// entirely; maxSteps is then grown (see renderFrame()) so a shrunk step
// still reaches the far face, capped here so worst-case anisotropy can't
// produce an unbounded per-pixel loop.
constexpr float kFinestAxisStepMultiplier = 1.5F;
constexpr float kMaxRayStepsHardCap = 2048.0F;

// Caps accumFrameIndex_'s growth: the temporal blend weight is
// 1/(accumFrameIndex_+1), which decays toward zero forever if left
// uncapped -- after enough idle requestAnimationFrame ticks, genuinely
// new content (e.g. a mask slice arriving asynchronously) would blend in
// with a weight too small to survive 8-bit swapchain quantization,
// silently "freezing" the displayed image. Capping keeps at least
// 1/(kMaxAccumFrames+1) weight on the newest frame.
constexpr float kMaxAccumFrames = 31.0F;

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
    // uses ASYNCIFY/emscripten_sleep -- the spontaneous-callback trap is a
    // callback firing while the main stack is suspended inside ASYNCIFY,
    // which cannot happen in this design.
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

    // `timestamp-query` is optional (rhi::Device::getGpuTiming's header
    // comment) -- only request it if the adapter actually supports it, and
    // remember the result so the rest of this class knows whether to
    // create the query set / write timestamps at all. Detecting the
    // feature here, before device creation, is what makes the later
    // activation (creating the query set) correct instead of a guess.
    self->timestampQuerySupported_ = wgpuAdapterHasFeature(adapter, WGPUFeatureName_TimestampQuery) != 0U;

    // The default maxBufferSize (256 MiB) is too small for gradientTexture_
    // on a clinically-sized volume -- Dawn's internal lazy-clear needs a
    // staging buffer as large as the texture itself (RGBA16Float, 4x the
    // R16Float volume texture's size), which fails validation against the
    // default limit and leaves the raymarch output black. Request the
    // adapter's own reported ceiling instead of a fixed number the next
    // larger volume could exceed again: requiredLimits only asks Dawn to
    // guarantee a limit already reported as supported (no preallocation),
    // so a weaker adapter still gets exactly its own default.
    WGPULimits adapterLimits = WGPU_LIMITS_INIT;
    wgpuAdapterGetLimits(adapter, &adapterLimits);
    WGPULimits requiredLimits = WGPU_LIMITS_INIT;
    requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;

    WGPURequestDeviceCallbackInfo deviceCallbackInfo{};
    deviceCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    deviceCallbackInfo.callback = &WebGPUDevice::onDeviceRequested;
    deviceCallbackInfo.userdata1 = self;

    // Must outlive the wgpuAdapterRequestDevice() call below, so it can't
    // be scoped to the if-block: Emscripten's JS glue reads through
    // deviceDesc.requiredFeatures when it marshals deviceDesc, which
    // happens after the block would have ended.
    WGPUFeatureName const requiredFeatures[1] = {WGPUFeatureName_TimestampQuery};

    WGPUDeviceDescriptor deviceDesc{};
    deviceDesc.requiredLimits = &requiredLimits;
    if (self->timestampQuerySupported_) {
        deviceDesc.requiredFeatureCount = 1;
        deviceDesc.requiredFeatures = requiredFeatures;
    }
    // Mobile OOM mitigation (rhi::Device::getDeviceLossState) -- both
    // callbacks are registered on this descriptor rather than a separate
    // post-creation setter, since WGPUDeviceDescriptor is where Dawn's
    // CallbackInfo-based API expects them. AllowSpontaneous is safe here
    // for the same reason as callbackInfo.mode above (no ASYNCIFY in this
    // engine).
    deviceDesc.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    deviceDesc.deviceLostCallbackInfo.callback = &WebGPUDevice::onDeviceLost;
    deviceDesc.deviceLostCallbackInfo.userdata1 = self;
    deviceDesc.uncapturedErrorCallbackInfo.callback = &WebGPUDevice::onUncapturedError;
    deviceDesc.uncapturedErrorCallbackInfo.userdata1 = self;
    wgpuAdapterRequestDevice(adapter, &deviceDesc, deviceCallbackInfo);
}

void WebGPUDevice::onDeviceLost(WGPUDevice const* /*device*/, WGPUDeviceLostReason reason, WGPUStringView message,
                                 void* userdata1, void* /*userdata2*/) {
    auto* self = static_cast<WebGPUDevice*>(userdata1);
    logStringView("WebGPUDevice: device lost", message);
    self->deviceLost_ = true;
    switch (reason) {
        case WGPUDeviceLostReason_Destroyed:
            self->deviceLossReason_ = DeviceLossReason::Destroyed;
            break;
        case WGPUDeviceLostReason_FailedCreation:
            self->deviceLossReason_ = DeviceLossReason::FailedCreation;
            break;
        default:
            self->deviceLossReason_ = DeviceLossReason::Unknown;
            break;
    }
    self->deviceLossMessage_ = stringViewToStdString(message);
}

void WebGPUDevice::onUncapturedError(WGPUDevice const* /*device*/, WGPUErrorType /*type*/, WGPUStringView message,
                                      void* userdata1, void* /*userdata2*/) {
    auto* self = static_cast<WebGPUDevice*>(userdata1);
    logStringView("WebGPUDevice: uncaptured error", message);
    // Deliberately does NOT set deviceLost_ -- an uncaptured error does
    // not necessarily mean the whole device is gone (see
    // rhi::DeviceLossSnapshot's header comment).
    self->hasUncapturedError_ = true;
    self->uncapturedErrorMessage_ = stringViewToStdString(message);
}

void WebGPUDevice::debugSimulateDeviceLost() {
    static char const kMessage[] = "simulated for e2e testing (engine_debug_simulate_device_lost)";
    onDeviceLost(nullptr, WGPUDeviceLostReason_Unknown, WGPUStringView{kMessage, sizeof(kMessage) - 1}, this,
                 nullptr);
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

    // vendor/architecture/device/description are WGPUStringView in the
    // emdawnwebgpu port's header (same .data/.length shape logStringView()
    // handles for the async-callback message params), not plain char
    // const*. Dawn allocates the backing storage;
    // wgpuAdapterInfoFreeMembers() releases it once it's copied into
    // hardwareInfo_'s std::strings.
    WGPUAdapterInfo adapterInfo{};
    if (wgpuAdapterGetInfo(self->adapter_, &adapterInfo) == WGPUStatus_Success) {
        auto toStdString = [](WGPUStringView view) {
            return (view.data && view.length > 0) ? std::string(view.data, view.length) : std::string();
        };
        self->hardwareInfo_.vendor = toStdString(adapterInfo.vendor);
        self->hardwareInfo_.architecture = toStdString(adapterInfo.architecture);
        self->hardwareInfo_.device = toStdString(adapterInfo.device);
        self->hardwareInfo_.description = toStdString(adapterInfo.description);
        wgpuAdapterInfoFreeMembers(adapterInfo);
    } else {
        std::printf("WebGPUDevice: wgpuAdapterGetInfo failed\n");
    }

    self->configureSurface();
    self->createSamplerAndLut();
    self->createPipeline();
    self->createCompositePipeline();
    self->createGradientBakePipeline();
    self->createAccumulationResources();
    if (self->timestampQuerySupported_) {
        self->createTimestampQuery();
    }
    self->ready_ = true;
}

void WebGPUDevice::createTimestampQuery() {
    WGPUQuerySetDescriptor querySetDesc{};
    querySetDesc.type = WGPUQueryType_Timestamp;
    querySetDesc.count = kTimestampQueryCount;
    timestampQuerySet_ = wgpuDeviceCreateQuerySet(device_, &querySetDesc);

    WGPUBufferDescriptor resolveDesc{};
    resolveDesc.size = kTimestampQueryCount * sizeof(uint64_t);
    resolveDesc.usage = WGPUBufferUsage_QueryResolve | WGPUBufferUsage_CopySrc;
    timestampResolveBuffer_ = wgpuDeviceCreateBuffer(device_, &resolveDesc);

    WGPUBufferDescriptor readbackDesc{};
    readbackDesc.size = kTimestampQueryCount * sizeof(uint64_t);
    readbackDesc.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    timestampReadbackBuffer_ = wgpuDeviceCreateBuffer(device_, &readbackDesc);
}

void WebGPUDevice::configureSurface() {
    WGPUSurfaceConfiguration config{};
    config.device = device_;
    config.format = WGPUTextureFormat_BGRA8Unorm;
    config.usage = WGPUTextureUsage_RenderAttachment;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.width = canvasWidth_;
    config.height = canvasHeight_;
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

    WGPUTextureViewDescriptor viewDesc{};
    viewDesc.format = WGPUTextureFormat_RGBA8Unorm;
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.mipLevelCount = 1;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;
    lutTextureView_ = wgpuTextureCreateView(lutTexture_, &viewDesc);

    WGPUTextureDescriptor preintegratedDesc{};
    preintegratedDesc.dimension = WGPUTextureDimension_2D;
    preintegratedDesc.size = WGPUExtent3D{kPreintegratedLutSize, kPreintegratedLutSize, 1};
    preintegratedDesc.format = WGPUTextureFormat_RGBA8Unorm;
    preintegratedDesc.mipLevelCount = 1;
    preintegratedDesc.sampleCount = 1;
    preintegratedDesc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    preintegratedLutTexture_ = wgpuDeviceCreateTexture(device_, &preintegratedDesc);

    WGPUTextureViewDescriptor preintegratedViewDesc{};
    preintegratedViewDesc.format = WGPUTextureFormat_RGBA8Unorm;
    preintegratedViewDesc.dimension = WGPUTextureViewDimension_2D;
    preintegratedViewDesc.mipLevelCount = 1;
    preintegratedViewDesc.arrayLayerCount = 1;
    preintegratedViewDesc.aspect = WGPUTextureAspect_All;
    preintegratedLutTextureView_ = wgpuTextureCreateView(preintegratedLutTexture_, &preintegratedViewDesc);

    setColormapPreset(kDefaultColormapPreset);
}

// Writes a color ramp into lutTexture_ -- r/g/b lerp from lowColor to
// highColor across the ramp, alpha a linear-with-density ramp (a=t)
// regardless of color, so only hue changes. Called from
// createSamplerAndLut() (startup), setColormapPreset() (every preset
// click, with kGrayscaleLow/High), and setCustomColormap() (with
// whatever the color pickers currently hold).
void WebGPUDevice::writeLutColors(ColorRGB lowColor, ColorRGB highColor) {
    std::array<uint8_t, kLutSize * 4> lutData{};
    for (uint32_t i = 0; i < kLutSize; ++i) {
        float const t = static_cast<float>(i) / static_cast<float>(kLutSize - 1);
        lutData[i * 4 + 0] =
            static_cast<uint8_t>(std::lerp(static_cast<float>(lowColor.r), static_cast<float>(highColor.r), t));
        lutData[i * 4 + 1] =
            static_cast<uint8_t>(std::lerp(static_cast<float>(lowColor.g), static_cast<float>(highColor.g), t));
        lutData[i * 4 + 2] =
            static_cast<uint8_t>(std::lerp(static_cast<float>(lowColor.b), static_cast<float>(highColor.b), t));
        lutData[i * 4 + 3] = static_cast<uint8_t>((i * 255) / (kLutSize - 1));
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
}

// Bakes kColormapPresets[presetId] into preintegratedLutTexture_ (Engel
// et al. "High-Quality Pre-Integrated Volume Rendering"). For every
// (front, back) classification-value pair, numerically (trapezoidal)
// integrates the segment assuming density varies linearly between them,
// storing:
//   rgb = average color across the segment, weighted by local absorption
//   a   = "sBar", the average classification value across the segment
//         (NOT scaled by extinction -- tau(s) = extinction*s is linear in
//         s, so the extinction factor cancels out of the average and can
//         stay a runtime-read UBO value; see volume_raymarch.slang's
//         `alpha = 1 - exp(-extinction * sBar * stepSize)`). If a
//         non-extinction-proportional feature (e.g. a hard threshold
//         cutoff) is ever folded into the absorption model, this bake
//         must incorporate it directly -- shape and extinction would no
//         longer factor apart cleanly.
// Degenerates to single-point classification when front==back (no segment
// to integrate over). Only rebaked on a preset (or custom-color) change,
// not per frame or per window/level change.
void WebGPUDevice::writePreintegratedLutColors(ColorRGB lowColor, ColorRGB highColor) {
    auto classColor = [lowColor, highColor](float s) -> glm::vec3 {
        return glm::vec3{
                   std::lerp(static_cast<float>(lowColor.r), static_cast<float>(highColor.r), s),
                   std::lerp(static_cast<float>(lowColor.g), static_cast<float>(highColor.g), s),
                   std::lerp(static_cast<float>(lowColor.b), static_cast<float>(highColor.b), s),
               } /
               255.0F;
    };
    // Absorption "shape" at classification value s -- identity, matching
    // tau(s) = extinction*s with extinction factored out (see this
    // function's header comment).
    auto shape = [](float s) -> float { return s; };

    std::vector<uint8_t> lutData(static_cast<size_t>(kPreintegratedLutSize) * kPreintegratedLutSize * 4);

    for (uint32_t back = 0; back < kPreintegratedLutSize; ++back) {
        float const sb = static_cast<float>(back) / static_cast<float>(kPreintegratedLutSize - 1);
        for (uint32_t front = 0; front < kPreintegratedLutSize; ++front) {
            float const sf = static_cast<float>(front) / static_cast<float>(kPreintegratedLutSize - 1);

            float sBar;
            glm::vec3 colorBar;
            if (std::abs(sb - sf) < 1e-4F) {
                // Degenerate case: no segment to integrate over -- avoids
                // a 0/0 divide below and exactly reproduces the original
                // point-classification result for this one entry.
                sBar = shape(sf);
                colorBar = classColor(sf);
            } else {
                float const lo = std::min(sf, sb);
                float const hi = std::max(sf, sb);
                float shapeIntegral = 0.0F;
                glm::vec3 colorShapeIntegral{0.0F};
                float prevS = lo;
                float prevShape = shape(lo);
                glm::vec3 prevWeighted = classColor(lo) * prevShape;
                for (uint32_t k = 1; k <= kPreintegrationSubSamples; ++k) {
                    float const s =
                        lo + (hi - lo) * (static_cast<float>(k) / static_cast<float>(kPreintegrationSubSamples));
                    float const shapeS = shape(s);
                    glm::vec3 const weighted = classColor(s) * shapeS;
                    float const ds = s - prevS;
                    shapeIntegral += 0.5F * (prevShape + shapeS) * ds;
                    colorShapeIntegral += 0.5F * (prevWeighted + weighted) * ds;
                    prevS = s;
                    prevShape = shapeS;
                    prevWeighted = weighted;
                }
                // Normalize by the traversed range so this is an average,
                // not a raw integral -- makes sBar/colorBar degenerate to
                // the point-classification values as sb->sf.
                sBar = shapeIntegral / (hi - lo);
                colorBar = (sBar > 1e-8F) ? (colorShapeIntegral / (hi - lo)) / sBar : classColor(sf);
            }

            size_t const idx = (static_cast<size_t>(back) * kPreintegratedLutSize + front) * 4;
            lutData[idx + 0] = static_cast<uint8_t>(std::clamp(colorBar.r, 0.0F, 1.0F) * 255.0F);
            lutData[idx + 1] = static_cast<uint8_t>(std::clamp(colorBar.g, 0.0F, 1.0F) * 255.0F);
            lutData[idx + 2] = static_cast<uint8_t>(std::clamp(colorBar.b, 0.0F, 1.0F) * 255.0F);
            lutData[idx + 3] = static_cast<uint8_t>(std::clamp(sBar, 0.0F, 1.0F) * 255.0F);
        }
    }

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = preintegratedLutTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, 0};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = kPreintegratedLutSize * 4;
    layout.rowsPerImage = kPreintegratedLutSize;

    WGPUExtent3D writeSize{kPreintegratedLutSize, kPreintegratedLutSize, 1};
    wgpuQueueWriteTexture(queue_, &dst, lutData.data(), lutData.size(), &layout, &writeSize);
}

namespace {
WGPUShaderModule createShaderModuleFromWgsl(WGPUDevice device, char const* wgslSource) {
    WGPUShaderModuleDescriptor shaderDesc{};
    WGPUShaderSourceWGSL wgslSourceDesc{};
    wgslSourceDesc.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgslSourceDesc.code = WGPUStringView{wgslSource, WGPU_STRLEN};
    shaderDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&wgslSourceDesc);
    return wgpuDeviceCreateShaderModule(device, &shaderDesc);
}
}  // namespace

WGPURenderPipeline WebGPUDevice::createRenderPipelineFor(WGPUShaderModule module,
                                                           WGPUTextureFormat colorTargetFormat) {
    // Constant/OneMinusConstant, not a shader-alpha-driven blend --
    // wgpuRenderPassEncoderSetBlendConstant() lets renderFrame() drive a
    // per-frame temporal blend weight (1/(accumFrameIndex_+1) for the
    // raymarch pass into accumulationTexture_, 1.0 -- a full overwrite --
    // for the axial-slice pass into the swapchain, which doesn't
    // participate in accumulation). Both shaders resolve their own
    // volume-opacity-vs-background compositing internally and always
    // output alpha=1 (see volume_raymarch.slang's fragmentMain header
    // comment) so this blend stage is purely a temporal weight, not
    // entangled with per-pixel volume alpha.
    WGPUBlendComponent colorBlend{};
    colorBlend.operation = WGPUBlendOperation_Add;
    colorBlend.srcFactor = WGPUBlendFactor_Constant;
    colorBlend.dstFactor = WGPUBlendFactor_OneMinusConstant;

    WGPUBlendComponent alphaBlend{};
    alphaBlend.operation = WGPUBlendOperation_Add;
    alphaBlend.srcFactor = WGPUBlendFactor_Constant;
    alphaBlend.dstFactor = WGPUBlendFactor_OneMinusConstant;

    WGPUBlendState blendState{};
    blendState.color = colorBlend;
    blendState.alpha = alphaBlend;

    WGPUColorTargetState colorTarget{};
    colorTarget.format = colorTargetFormat;
    colorTarget.blend = &blendState;
    colorTarget.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragmentState{};
    fragmentState.module = module;
    fragmentState.entryPoint = WGPUStringView{"fragmentMain", WGPU_STRLEN};
    fragmentState.targetCount = 1;
    fragmentState.targets = &colorTarget;

    WGPURenderPipelineDescriptor pipelineDesc{};
    pipelineDesc.layout = pipelineLayout_;
    pipelineDesc.vertex.module = module;
    pipelineDesc.vertex.entryPoint = WGPUStringView{"vertexMain", WGPU_STRLEN};
    pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pipelineDesc.primitive.frontFace = WGPUFrontFace_CCW;
    pipelineDesc.primitive.cullMode = WGPUCullMode_None;
    pipelineDesc.multisample.count = 1;
    pipelineDesc.multisample.mask = 0xFFFFFFFF;
    pipelineDesc.fragment = &fragmentState;
    return wgpuDeviceCreateRenderPipeline(device_, &pipelineDesc);
}

void WebGPUDevice::createPipeline() {
    shaderModule_ = createShaderModuleFromWgsl(device_, kVolumeRaymarchWgsl);
    axialShaderModule_ = createShaderModuleFromWgsl(device_, kAxialSliceWgsl);

    // Shared by both pipelines -- both shaders declare the same 7-entry
    // layout (bindings 5 and 6, the pre-integrated LUT and gradient
    // volume, are declared but unused by axial_slice.slang; see its own
    // comment). See createRenderPipelineFor()'s header comment for why one
    // bind group layout/pipeline layout/UBO buffer is valid for both.
    std::array<WGPUBindGroupLayoutEntry, 7> entries{};
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

    entries[5].binding = 5;
    entries[5].visibility = WGPUShaderStage_Fragment;
    entries[5].texture.sampleType = WGPUTextureSampleType_Float;
    entries[5].texture.viewDimension = WGPUTextureViewDimension_2D;

    // Precomputed gradient volume (gradient_bake.slang) -- see
    // volume_raymarch.slang's own binding-6 comment. Sampled trilinearly
    // (linearSampler_, entry 2 above), so Float (filterable), not
    // UnfilterableFloat.
    entries[6].binding = 6;
    entries[6].visibility = WGPUShaderStage_Fragment;
    entries[6].texture.sampleType = WGPUTextureSampleType_Float;
    entries[6].texture.viewDimension = WGPUTextureViewDimension_3D;

    WGPUBindGroupLayoutDescriptor bglDesc{};
    bglDesc.entryCount = entries.size();
    bglDesc.entries = entries.data();
    bindGroupLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &bglDesc);

    WGPUPipelineLayoutDescriptor layoutDesc{};
    layoutDesc.bindGroupLayoutCount = 1;
    layoutDesc.bindGroupLayouts = &bindGroupLayout_;
    pipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &layoutDesc);

    // pipeline_ (raymarch) targets accumulationTexture_ (RGBA16Float),
    // not the swapchain -- axialPipeline_ draws directly to the swapchain
    // (BGRA8Unorm). See createRenderPipelineFor's header comment for why
    // this format must match exactly.
    pipeline_ = createRenderPipelineFor(shaderModule_, WGPUTextureFormat_RGBA16Float);
    axialPipeline_ = createRenderPipelineFor(axialShaderModule_, WGPUTextureFormat_BGRA8Unorm);

    // Sized for the larger of the two UBOs (RaymarchUBO) -- AxialSliceUBO
    // (48 bytes) is written into the same buffer's leading bytes when the
    // axial-slice pipeline is active. See createRenderPipelineFor()'s
    // header comment for why WebGPU accepts one buffer/bind group across
    // both pipelines.
    WGPUBufferDescriptor uboDesc{};
    uboDesc.size = sizeof(RaymarchUBO);
    uboDesc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    uboBuffer_ = wgpuDeviceCreateBuffer(device_, &uboDesc);
}

// One-time setup for the accumulation-blit pass -- a 2-entry bind group
// layout (texture + sampler) distinct from bindGroupLayout_/
// pipelineLayout_ above, since this shader has entirely different
// resources. Blend is left at its WebGPU default (no blending -- a plain
// overwrite) since accumulationTexture_ always holds a fully-resolved,
// opaque frame by the time this pass reads it.
void WebGPUDevice::createCompositePipeline() {
    compositeShaderModule_ = createShaderModuleFromWgsl(device_, kAccumulationBlitWgsl);

    std::array<WGPUBindGroupLayoutEntry, 2> entries{};
    entries[0].binding = 0;
    entries[0].visibility = WGPUShaderStage_Fragment;
    entries[0].texture.sampleType = WGPUTextureSampleType_Float;
    entries[0].texture.viewDimension = WGPUTextureViewDimension_2D;

    entries[1].binding = 1;
    entries[1].visibility = WGPUShaderStage_Fragment;
    entries[1].sampler.type = WGPUSamplerBindingType_Filtering;

    WGPUBindGroupLayoutDescriptor bglDesc{};
    bglDesc.entryCount = entries.size();
    bglDesc.entries = entries.data();
    compositeBindGroupLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &bglDesc);

    WGPUPipelineLayoutDescriptor layoutDesc{};
    layoutDesc.bindGroupLayoutCount = 1;
    layoutDesc.bindGroupLayouts = &compositeBindGroupLayout_;
    compositePipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &layoutDesc);

    WGPUColorTargetState colorTarget{};
    colorTarget.format = WGPUTextureFormat_BGRA8Unorm;
    colorTarget.blend = nullptr;
    colorTarget.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragmentState{};
    fragmentState.module = compositeShaderModule_;
    fragmentState.entryPoint = WGPUStringView{"fragmentMain", WGPU_STRLEN};
    fragmentState.targetCount = 1;
    fragmentState.targets = &colorTarget;

    WGPURenderPipelineDescriptor pipelineDesc{};
    pipelineDesc.layout = compositePipelineLayout_;
    pipelineDesc.vertex.module = compositeShaderModule_;
    pipelineDesc.vertex.entryPoint = WGPUStringView{"vertexMain", WGPU_STRLEN};
    pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pipelineDesc.primitive.frontFace = WGPUFrontFace_CCW;
    pipelineDesc.primitive.cullMode = WGPUCullMode_None;
    pipelineDesc.multisample.count = 1;
    pipelineDesc.multisample.mask = 0xFFFFFFFF;
    pipelineDesc.fragment = &fragmentState;
    compositePipeline_ = wgpuDeviceCreateRenderPipeline(device_, &pipelineDesc);
}

void WebGPUDevice::createGradientBakePipeline() {
    gradientBakeShaderModule_ = createShaderModuleFromWgsl(device_, kGradientBakeWgsl);

    std::array<WGPUBindGroupLayoutEntry, 3> entries{};
    entries[0].binding = 0;
    entries[0].visibility = WGPUShaderStage_Compute;
    entries[0].texture.sampleType = WGPUTextureSampleType_Float;
    entries[0].texture.viewDimension = WGPUTextureViewDimension_3D;

    entries[1].binding = 1;
    entries[1].visibility = WGPUShaderStage_Compute;
    // WriteOnly, matching gradient_bake.slang's WTexture3D declaration
    // (its own comment explains why RWTexture3D's default read_write
    // access doesn't work here -- RGBA16Float isn't one of the handful of
    // formats WebGPU's base feature set allows read-write storage access
    // for).
    entries[1].storageTexture.access = WGPUStorageTextureAccess_WriteOnly;
    entries[1].storageTexture.format = WGPUTextureFormat_RGBA16Float;
    entries[1].storageTexture.viewDimension = WGPUTextureViewDimension_3D;

    entries[2].binding = 2;
    entries[2].visibility = WGPUShaderStage_Compute;
    entries[2].buffer.type = WGPUBufferBindingType_Uniform;

    WGPUBindGroupLayoutDescriptor bglDesc{};
    bglDesc.entryCount = entries.size();
    bglDesc.entries = entries.data();
    gradientBakeBindGroupLayout_ = wgpuDeviceCreateBindGroupLayout(device_, &bglDesc);

    WGPUPipelineLayoutDescriptor layoutDesc{};
    layoutDesc.bindGroupLayoutCount = 1;
    layoutDesc.bindGroupLayouts = &gradientBakeBindGroupLayout_;
    gradientBakePipelineLayout_ = wgpuDeviceCreatePipelineLayout(device_, &layoutDesc);

    WGPUComputePipelineDescriptor pipelineDesc{};
    pipelineDesc.layout = gradientBakePipelineLayout_;
    pipelineDesc.compute.module = gradientBakeShaderModule_;
    pipelineDesc.compute.entryPoint = WGPUStringView{"computeMain", WGPU_STRLEN};
    gradientBakePipeline_ = wgpuDeviceCreateComputePipeline(device_, &pipelineDesc);

    // GradientBakeParams is one float4 (spacing.xyz, w unused) -- see
    // gradient_bake.slang's own struct. Rewritten per loadVolume() call
    // (bakeGradientVolume()), never resized -- its size never changes.
    WGPUBufferDescriptor paramsDesc{};
    paramsDesc.size = sizeof(glm::vec4);
    paramsDesc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    gradientBakeParamsBuffer_ = wgpuDeviceCreateBuffer(device_, &paramsDesc);
}

void WebGPUDevice::bakeGradientVolume(uint32_t width, uint32_t height, uint32_t depth,
                                       float spacingX, float spacingY, float spacingZ) {
    glm::vec4 const spacing{spacingX, spacingY, spacingZ, 0.0F};
    wgpuQueueWriteBuffer(queue_, gradientBakeParamsBuffer_, 0, &spacing, sizeof(spacing));

    // Built fresh here rather than kept as a member -- this bind group
    // references volumeTextureView_/gradientTextureView_, both of which
    // are recreated on every loadVolume() call, and bakeGradientVolume()
    // itself only ever runs once per load right after those views exist.
    std::array<WGPUBindGroupEntry, 3> entries{};
    entries[0].binding = 0;
    entries[0].textureView = volumeTextureView_;
    entries[1].binding = 1;
    entries[1].textureView = gradientTextureView_;
    entries[2].binding = 2;
    entries[2].buffer = gradientBakeParamsBuffer_;
    entries[2].offset = 0;
    entries[2].size = sizeof(glm::vec4);

    WGPUBindGroupDescriptor bgDesc{};
    bgDesc.layout = gradientBakeBindGroupLayout_;
    bgDesc.entryCount = entries.size();
    bgDesc.entries = entries.data();
    WGPUBindGroup bindGroup = wgpuDeviceCreateBindGroup(device_, &bgDesc);

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, nullptr);
    wgpuComputePassEncoderSetPipeline(pass, gradientBakePipeline_);
    wgpuComputePassEncoderSetBindGroup(pass, 0, bindGroup, 0, nullptr);
    // numthreads(4,4,4) in gradient_bake.slang -- round up so every voxel
    // gets a thread even when a dimension isn't a multiple of 4 (the
    // shader's own bounds check discards the excess threads harmlessly).
    uint32_t const groupsX = (width + 3) / 4;
    uint32_t const groupsY = (height + 3) / 4;
    uint32_t const groupsZ = (depth + 3) / 4;
    wgpuComputePassEncoderDispatchWorkgroups(pass, groupsX, groupsY, groupsZ);
    wgpuComputePassEncoderEnd(pass);

    WGPUCommandBuffer cmdBuffer = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(queue_, 1, &cmdBuffer);

    wgpuCommandBufferRelease(cmdBuffer);
    wgpuComputePassEncoderRelease(pass);
    wgpuCommandEncoderRelease(encoder);
    wgpuBindGroupRelease(bindGroup);
}

// (Re)creates accumulationTexture_/View at the current canvasWidth_/
// canvasHeight_, and the bind group that references it -- see
// accumulationTexture_'s header comment (WebGPUDevice.hpp) for why a
// persistent offscreen texture is needed at all. Called once when the
// device becomes ready, and again from resize() every time the canvas
// size actually changes, since a WGPUTexture's size is fixed at creation.
void WebGPUDevice::createAccumulationResources() {
    if (compositeBindGroup_) {
        wgpuBindGroupRelease(compositeBindGroup_);
        compositeBindGroup_ = nullptr;
    }
    if (accumulationTextureView_) {
        wgpuTextureViewRelease(accumulationTextureView_);
        accumulationTextureView_ = nullptr;
    }
    if (accumulationTexture_) {
        wgpuTextureRelease(accumulationTexture_);
        accumulationTexture_ = nullptr;
    }

    WGPUTextureDescriptor desc{};
    desc.dimension = WGPUTextureDimension_2D;
    desc.size = WGPUExtent3D{canvasWidth_, canvasHeight_, 1};
    desc.format = WGPUTextureFormat_RGBA16Float;
    desc.mipLevelCount = 1;
    desc.sampleCount = 1;
    desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    accumulationTexture_ = wgpuDeviceCreateTexture(device_, &desc);

    WGPUTextureViewDescriptor viewDesc{};
    viewDesc.format = WGPUTextureFormat_RGBA16Float;
    viewDesc.dimension = WGPUTextureViewDimension_2D;
    viewDesc.mipLevelCount = 1;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;
    accumulationTextureView_ = wgpuTextureCreateView(accumulationTexture_, &viewDesc);

    std::array<WGPUBindGroupEntry, 2> entries{};
    entries[0].binding = 0;
    entries[0].textureView = accumulationTextureView_;
    entries[1].binding = 1;
    entries[1].sampler = linearSampler_;

    WGPUBindGroupDescriptor bgDesc{};
    bgDesc.layout = compositeBindGroupLayout_;
    bgDesc.entryCount = entries.size();
    bgDesc.entries = entries.data();
    compositeBindGroup_ = wgpuDeviceCreateBindGroup(device_, &bgDesc);
}

void WebGPUDevice::frameCameraForVolume(uint32_t width, uint32_t height, uint32_t depth,
                                         float spacingX, float spacingY, float spacingZ) {
    // World-space AABB, centered at the origin, in the same physical
    // millimeter units as spacingX/Y/Z. World axes already match the
    // canonical LPS convention the Parse Worker normalizes to upstream
    // (X=Left, Y=Posterior, Z=Superior) -- see this method's header comment.
    glm::vec3 const halfExtent{
        static_cast<float>(width) * spacingX * 0.5F,
        static_cast<float>(height) * spacingY * 0.5F,
        static_cast<float>(depth) * spacingZ * 0.5F,
    };
    aabbMin_ = -halfExtent;
    aabbMax_ = halfExtent;
    finestSpacing_ = std::min({spacingX, spacingY, spacingZ});
    // Reset the clip box to the full volume -- a clip region sized for a
    // previously loaded (differently sized) volume would otherwise
    // misclip this new one.
    clipMin_ = aabbMin_;
    clipMax_ = aabbMax_;

    cameraYaw_ = glm::radians(35.0F);
    cameraPitch_ = glm::radians(25.0F);
    cameraDistance_ = glm::length(halfExtent) * 2.5F;

    updateCameraMatrices();
}

void WebGPUDevice::updateCameraMatrices() {
    // Spherical-coordinate orbit camera (yaw/pitch/distance around the
    // AABB's center). up=+Z (patient Superior) puts the top of the patient
    // at the top of the frame -- handled at the camera rather than with a
    // pixel-row flip, since this engine's world axes are already
    // LPS-canonical by the time loadVolume() is called.
    glm::vec3 const eye{
        cameraDistance_ * std::cos(cameraPitch_) * std::sin(cameraYaw_),
        cameraDistance_ * std::cos(cameraPitch_) * std::cos(cameraYaw_) * -1.0F,
        cameraDistance_ * std::sin(cameraPitch_),
    };
    cameraPos_ = eye;

    glm::mat4 const view = glm::lookAt(eye, glm::vec3{0.0F}, glm::vec3{0.0F, 0.0F, 1.0F});
    float const aspect = static_cast<float>(canvasWidth_) / static_cast<float>(canvasHeight_);
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

    std::array<WGPUBindGroupEntry, 7> entries{};
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

    entries[5].binding = 5;
    entries[5].textureView = preintegratedLutTextureView_;

    entries[6].binding = 6;
    entries[6].textureView = gradientTextureView_;

    WGPUBindGroupDescriptor bgDesc{};
    bgDesc.layout = bindGroupLayout_;
    bgDesc.entryCount = entries.size();
    bgDesc.entries = entries.data();
    bindGroup_ = wgpuDeviceCreateBindGroup(device_, &bgDesc);
}

void WebGPUDevice::renderFrame() {
    // deviceLost_/pauseRendering_ (mobile OOM mitigation) alongside
    // !ready_ -- deviceLost_ because device_/queue_ are stale handles
    // once the device is lost (any further wgpuQueueSubmit/etc. through
    // them would be undefined behavior); pauseRendering_ because a full
    // early return (no encoder, no submission at all) is what actually
    // frees the GPU for concurrent AI inference during the paused window
    // (setRenderPaused's own header comment on why a partial pause
    // wouldn't).
    if (!ready_ || deviceLost_ || pauseRendering_) {
        return;
    }

    frameStats_.recordFrame();

    WGPUSurfaceTexture surfaceTexture{};
    wgpuSurfaceGetCurrentTexture(surface_, &surfaceTexture);
    bool const acquired = surfaceTexture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal ||
                           surfaceTexture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal;
    if (!acquired) {
        return;
    }

    WGPUTextureView view = wgpuTextureCreateView(surfaceTexture.texture, nullptr);
    renderGraph_.transition("swapchain", core::ResourceState::RenderTarget);

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device_, nullptr);

    // Opaque full-overwrite blend constant -- used by the axial-slice pass
    // below (which doesn't participate in temporal accumulation) and as
    // the raymarch pass's own weight on its first/dirty frame.
    WGPUColor const kOpaqueBlendConstant{1.0, 1.0, 1.0, 1.0};

    // How many of timestampQuerySet_'s 4 slots this frame's branch below
    // actually writes -- 0 (no-volume branch, unsupported, or a readback
    // already in flight), 2 (AxialSlice2D), or 4 (Orbit3D: raymarch +
    // composite). Read after the if/else chain to decide whether/how much
    // to resolve and read back.
    //
    // Gated on !timestampReadbackPending_, not just
    // timestampQuerySupported_: this frame's
    // resolveQuerySet()+copyBufferToBuffer() write into
    // timestampReadbackBuffer_, the same buffer a previous frame's
    // still-in-flight wgpuBufferMapAsync() has pending/mapped, and WebGPU
    // forbids using a buffer in a submitted command while its map request
    // is pending. GPU readback latency is several frames at this frame
    // rate, so without the guard nearly every submission tripped that
    // validation error, and Dawn's handling of it caused rapid rendering
    // flicker.
    bool const wantTimestamps = timestampQuerySupported_ && !timestampReadbackPending_;
    uint32_t timestampQueryCountThisFrame = 0;
    WGPUPassTimestampWrites axialTimestampWrites{};
    WGPUPassTimestampWrites raymarchTimestampWrites{};
    WGPUPassTimestampWrites compositeTimestampWrites{};
    if (wantTimestamps) {
        axialTimestampWrites.querySet = timestampQuerySet_;
        axialTimestampWrites.beginningOfPassWriteIndex = 0;
        axialTimestampWrites.endOfPassWriteIndex = 1;
        raymarchTimestampWrites.querySet = timestampQuerySet_;
        raymarchTimestampWrites.beginningOfPassWriteIndex = 0;
        raymarchTimestampWrites.endOfPassWriteIndex = 1;
        compositeTimestampWrites.querySet = timestampQuerySet_;
        compositeTimestampWrites.beginningOfPassWriteIndex = 2;
        compositeTimestampWrites.endOfPassWriteIndex = 3;
    }

    if (hasVolume_ && pipeline_ && bindGroup_ && viewMode_ == kViewModeSlice2D && axialPipeline_) {
        renderGraph_.transition("volume", core::ResourceState::ShaderReadOnly);
        renderGraph_.transition("mask", core::ResourceState::ShaderReadOnly);

        WGPURenderPassColorAttachment colorAttachment{};
        colorAttachment.view = view;
        colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
        colorAttachment.loadOp = WGPULoadOp_Clear;
        colorAttachment.storeOp = WGPUStoreOp_Store;
        colorAttachment.clearValue =
            WGPUColor{backgroundColor_.r, backgroundColor_.g, backgroundColor_.b, 1.0};

        WGPURenderPassDescriptor passDesc{};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &colorAttachment;
        if (wantTimestamps) {
            passDesc.timestampWrites = &axialTimestampWrites;
            timestampQueryCountThisFrame = 2;
        }
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);

        // "Contain" letterbox fit -- see axial_slice.slang's fitParams
        // comment. aabbMax_-aabbMin_ already encodes the volume's physical
        // (spacing-aware) extent on all three axes
        // (frameCameraForVolume()), so no separate spacing storage is
        // needed here. Which two components form the displayed plane
        // depends on sliceAxis_ -- Axial shows X/Y, Sagittal shows Y/Z,
        // Coronal shows X/Z.
        glm::vec3 const physicalExtent = aabbMax_ - aabbMin_;
        float volumeAspect;
        if (sliceAxis_ == kSliceAxisSagittal) {
            volumeAspect = physicalExtent.y / physicalExtent.z;
        } else if (sliceAxis_ == kSliceAxisCoronal) {
            volumeAspect = physicalExtent.x / physicalExtent.z;
        } else {
            volumeAspect = physicalExtent.x / physicalExtent.y;
        }
        float const canvasAspect = static_cast<float>(canvasWidth_) / static_cast<float>(canvasHeight_);
        float const fitScaleX = std::max(1.0F, canvasAspect / volumeAspect);
        float const fitScaleY = std::max(1.0F, volumeAspect / canvasAspect);

        AxialSliceUBO ubo{};
        ubo.sliceParams =
            glm::vec4{static_cast<float>(sliceIndex_), windowCenter_, windowWidth_, static_cast<float>(sliceAxis_)};
        ubo.maskParams = glm::vec4{maskOverlayEnabled_ ? 1.0F : 0.0F, maskOverlayAlpha_, 0.0F, 0.0F};
        ubo.fitParams = glm::vec4{fitScaleX, fitScaleY, 0.0F, 0.0F};

        wgpuQueueWriteBuffer(queue_, uboBuffer_, 0, &ubo, sizeof(ubo));

        wgpuRenderPassEncoderSetPipeline(pass, axialPipeline_);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup_, 0, nullptr);
        wgpuRenderPassEncoderSetBlendConstant(pass, &kOpaqueBlendConstant);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);

        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
    } else if (hasNativeVolume_ && nativeBindGroup_ && viewMode_ == kViewModeNativeSlice2D && axialPipeline_) {
        // Native-slice view -- the DICOM series' own original per-file
        // slices, entirely separate from the (possibly reformatted)
        // primary volume. Reuses
        // axialPipeline_/axial_slice.slang unchanged: this view always
        // scans nativeBindGroup_'s own volume texture along its Z axis
        // (sliceAxis=0/Axial-style in the shader's terms, since the
        // native volume's own "depth" IS the file order, not a real
        // spatial axis requiring MPR) with mask overlay forced off (its
        // class indices only line up with the primary volume's geometry).
        renderGraph_.transition("volume", core::ResourceState::ShaderReadOnly);
        renderGraph_.transition("mask", core::ResourceState::ShaderReadOnly);

        WGPURenderPassColorAttachment colorAttachment{};
        colorAttachment.view = view;
        colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
        colorAttachment.loadOp = WGPULoadOp_Clear;
        colorAttachment.storeOp = WGPUStoreOp_Store;
        colorAttachment.clearValue =
            WGPUColor{backgroundColor_.r, backgroundColor_.g, backgroundColor_.b, 1.0};

        WGPURenderPassDescriptor passDesc{};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &colorAttachment;
        if (wantTimestamps) {
            passDesc.timestampWrites = &axialTimestampWrites;
            timestampQueryCountThisFrame = 2;
        }
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);

        float const nativeVolumeAspect = (static_cast<float>(nativeVolumeWidth_) * nativeSpacingX_) /
                                          (static_cast<float>(nativeVolumeHeight_) * nativeSpacingY_);
        float const canvasAspect = static_cast<float>(canvasWidth_) / static_cast<float>(canvasHeight_);
        float const fitScaleX = std::max(1.0F, canvasAspect / nativeVolumeAspect);
        float const fitScaleY = std::max(1.0F, nativeVolumeAspect / canvasAspect);

        AxialSliceUBO ubo{};
        ubo.sliceParams = glm::vec4{static_cast<float>(nativeSliceIndex_), windowCenter_, windowWidth_, 0.0F};
        ubo.maskParams = glm::vec4{0.0F, 0.0F, 0.0F, 0.0F};
        ubo.fitParams = glm::vec4{fitScaleX, fitScaleY, 0.0F, 0.0F};

        wgpuQueueWriteBuffer(queue_, uboBuffer_, 0, &ubo, sizeof(ubo));

        wgpuRenderPassEncoderSetPipeline(pass, axialPipeline_);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, nativeBindGroup_, 0, nullptr);
        wgpuRenderPassEncoderSetBlendConstant(pass, &kOpaqueBlendConstant);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);

        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
    } else if (hasVolume_ && pipeline_ && bindGroup_ && compositePipeline_ && compositeBindGroup_) {
        renderGraph_.transition("volume", core::ResourceState::ShaderReadOnly);
        renderGraph_.transition("mask", core::ResourceState::ShaderReadOnly);

        glm::vec3 const halfExtent = (aabbMax_ - aabbMin_) * 0.5F;
        float const diagonal = glm::length(halfExtent) * 2.0F;

        QualityTier const& tier = kQualityTiers[qualityTier_];
        float stepSize = diagonal / tier.stepsAcrossDiagonal;
        float maxSteps = tier.maxSteps;
        // Anisotropic-spacing guard (see kFinestAxisStepMultiplier's
        // comment) -- only tightens stepSize, never loosens it, so a
        // volume with fine-enough spacing for the tier's default is
        // unaffected.
        if (finestSpacing_ > 0.0F) {
            float const clampedStepSize = std::min(stepSize, finestSpacing_ * kFinestAxisStepMultiplier);
            if (clampedStepSize < stepSize) {
                // Grow maxSteps to compensate so the shrunk step still
                // reaches the far face, capped to bound worst-case cost.
                maxSteps = std::min(diagonal / std::max(clampedStepSize, 1e-6F) * 1.33F, kMaxRayStepsHardCap);
                stepSize = clampedStepSize;
            }
        }

        // dirty (accumFrameIndex_==0) means this frame fully overwrites
        // accumulationTexture_ (Clear + weight 1.0); otherwise it blends
        // in with weight 1/(n+1), a running average across static frames.
        bool const dirty = accumFrameIndex_ <= 0.0F;
        float const blendWeight = 1.0F / (accumFrameIndex_ + 1.0F);

        RaymarchUBO ubo{};
        ubo.invView = invView_;
        ubo.invProj = invProj_;
        ubo.cameraPos = glm::vec4{cameraPos_, 0.0F};
        ubo.aabbMin = glm::vec4{aabbMin_, 0.0F};
        ubo.aabbMax = glm::vec4{aabbMax_, 0.0F};
        ubo.rayParams = glm::vec4{stepSize, maxSteps, extinction_, densityScale_};
        ubo.window = glm::vec4{windowCenter_, windowWidth_, 0.0F, 0.0F};
        ubo.maskParams = glm::vec4{maskOverlayEnabled_ ? 1.0F : 0.0F, maskOverlayAlpha_, 0.0F, 0.0F};
        ubo.shadingParams = glm::vec4{kLightDirection, static_cast<float>(shadingMode_)};
        ubo.jitterParams = glm::vec4{accumFrameIndex_, 1.0F, 0.0F, 0.0F};
        ubo.clipMin = glm::vec4{clipMin_, 0.0F};
        ubo.clipMax = glm::vec4{clipMax_, 0.0F};
        ubo.occlusionParams = glm::vec4{occlusionEnabled_ ? 1.0F : 0.0F, 1.0F, 0.0F, 0.0F};
        ubo.tfParams =
            glm::vec4{threshold_, gradientOpacityStrength_, downsampleFactor_ > 1 ? 1.0F : 0.0F, thresholdMax_};
        ubo.backgroundColor = glm::vec4{backgroundColor_, 0.0F};
        accumFrameIndex_ = std::min(accumFrameIndex_ + 1.0F, kMaxAccumFrames);

        wgpuQueueWriteBuffer(queue_, uboBuffer_, 0, &ubo, sizeof(ubo));

        // Pass A: raymarch into accumulationTexture_, blended with the
        // previous accumulated content (or fully overwriting it if dirty).
        WGPURenderPassColorAttachment accumAttachment{};
        accumAttachment.view = accumulationTextureView_;
        accumAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
        accumAttachment.loadOp = dirty ? WGPULoadOp_Clear : WGPULoadOp_Load;
        accumAttachment.storeOp = WGPUStoreOp_Store;
        accumAttachment.clearValue =
            WGPUColor{backgroundColor_.r, backgroundColor_.g, backgroundColor_.b, 1.0};

        WGPURenderPassDescriptor accumPassDesc{};
        accumPassDesc.colorAttachmentCount = 1;
        accumPassDesc.colorAttachments = &accumAttachment;
        if (wantTimestamps) {
            accumPassDesc.timestampWrites = &raymarchTimestampWrites;
        }
        WGPURenderPassEncoder accumPass = wgpuCommandEncoderBeginRenderPass(encoder, &accumPassDesc);

        WGPUColor const blendConstant{blendWeight, blendWeight, blendWeight, blendWeight};
        wgpuRenderPassEncoderSetPipeline(accumPass, pipeline_);
        wgpuRenderPassEncoderSetBindGroup(accumPass, 0, bindGroup_, 0, nullptr);
        wgpuRenderPassEncoderSetBlendConstant(accumPass, dirty ? &kOpaqueBlendConstant : &blendConstant);
        wgpuRenderPassEncoderDraw(accumPass, 3, 1, 0, 0);

        wgpuRenderPassEncoderEnd(accumPass);
        wgpuRenderPassEncoderRelease(accumPass);

        // Pass B: blit the (now-updated) accumulation buffer to the
        // swapchain -- see compositePipeline_'s header comment for why
        // this can't just be one pass targeting the swapchain directly.
        WGPURenderPassColorAttachment swapAttachment{};
        swapAttachment.view = view;
        swapAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
        swapAttachment.loadOp = WGPULoadOp_Clear;
        swapAttachment.storeOp = WGPUStoreOp_Store;
        swapAttachment.clearValue =
            WGPUColor{backgroundColor_.r, backgroundColor_.g, backgroundColor_.b, 1.0};

        WGPURenderPassDescriptor compositePassDesc{};
        compositePassDesc.colorAttachmentCount = 1;
        compositePassDesc.colorAttachments = &swapAttachment;
        if (wantTimestamps) {
            compositePassDesc.timestampWrites = &compositeTimestampWrites;
            timestampQueryCountThisFrame = 4;
        }
        WGPURenderPassEncoder compositePass = wgpuCommandEncoderBeginRenderPass(encoder, &compositePassDesc);

        wgpuRenderPassEncoderSetPipeline(compositePass, compositePipeline_);
        wgpuRenderPassEncoderSetBindGroup(compositePass, 0, compositeBindGroup_, 0, nullptr);
        wgpuRenderPassEncoderDraw(compositePass, 3, 1, 0, 0);

        wgpuRenderPassEncoderEnd(compositePass);
        wgpuRenderPassEncoderRelease(compositePass);
    } else {
        // No volume loaded yet (or pipelines not ready): a plain clear.
        WGPURenderPassColorAttachment colorAttachment{};
        colorAttachment.view = view;
        colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
        colorAttachment.loadOp = WGPULoadOp_Clear;
        colorAttachment.storeOp = WGPUStoreOp_Store;
        colorAttachment.clearValue =
            WGPUColor{backgroundColor_.r, backgroundColor_.g, backgroundColor_.b, 1.0};

        WGPURenderPassDescriptor passDesc{};
        passDesc.colorAttachmentCount = 1;
        passDesc.colorAttachments = &colorAttachment;
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
    }

    // Resolve+copy must be recorded on this same encoder, after the pass(es)
    // that wrote the timestamps and before wgpuCommandEncoderFinish -- a
    // resolveQuerySet call can only see queries written earlier in the same
    // command buffer. timestampQueryCountThisFrame is only ever nonzero when
    // wantTimestamps was true above, so no separate check needed here.
    if (timestampQueryCountThisFrame > 0) {
        wgpuCommandEncoderResolveQuerySet(encoder, timestampQuerySet_, 0, timestampQueryCountThisFrame,
                                           timestampResolveBuffer_, 0);
        wgpuCommandEncoderCopyBufferToBuffer(encoder, timestampResolveBuffer_, 0, timestampReadbackBuffer_, 0,
                                              timestampQueryCountThisFrame * sizeof(uint64_t));
    }

    WGPUCommandBuffer cmdBuffer = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(queue_, 1, &cmdBuffer);

    if (timestampQueryCountThisFrame > 0) {
        beginTimestampReadback(timestampQueryCountThisFrame);
    }

    // No wgpuSurfacePresent call -- unsupported in Emscripten, present
    // happens automatically via requestAnimationFrame under
    // emscripten_set_main_loop.
    wgpuCommandBufferRelease(cmdBuffer);
    wgpuCommandEncoderRelease(encoder);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(surfaceTexture.texture);
}

void WebGPUDevice::loadVolume(uint32_t volumeId, void const* data, size_t byteLength,
                               uint32_t width, uint32_t height, uint32_t depth,
                               float spacingX, float spacingY, float spacingZ, uint32_t downsampleFactor) {
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
    // Only committed once the load is confirmed valid -- setting this
    // before the check above would let a rejected (malformed) load's
    // downsampleFactor value silently apply to the *previous*, still-active
    // volume's already-created gradient texture on the next frame (e.g. a
    // rejected downsampleFactor > 1 would flip fragmentMain to
    // computeGradient() while the old, still-baked full gradient texture
    // sits unused, or a rejected downsampleFactor of 1 would flip it to
    // sample the old 1x1x1 dummy as if it were a real baked texture --
    // both wrong for a load that never actually happened).
    downsampleFactor_ = downsampleFactor;
    originalVolumeWidth_ = width;
    originalVolumeHeight_ = height;

    // A new volume load invalidates any mask texture from the previous
    // volume -- old mask data no longer applies (PRD #5.3.2).
    releaseVolumeResources();

    // Mobile OOM mitigation, on top of skipping the gradient texture:
    // downsampleFactor_ > 1 also shrinks the volume texture itself
    // in-plane (X/Y only -- see downsampleNearestXY's own comment for why
    // depth is untouched and nearest-neighbor is used instead of
    // averaging). The uint16_t const* reinterpret is safe here: data is
    // already validated above to be exactly width*height*depth*
    // sizeof(uint16_t) bytes, the buffer layout downsampleNearestXY
    // expects.
    std::vector<uint16_t> downsampledVolume;
    uint32_t textureWidth = width;
    uint32_t textureHeight = height;
    void const* uploadData = data;
    size_t uploadByteLength = byteLength;
    if (downsampleFactor_ > 1) {
        downsampledVolume = downsampleNearestXY(static_cast<uint16_t const*>(data), width, height, depth,
                                                 downsampleFactor_, textureWidth, textureHeight);
        uploadData = downsampledVolume.data();
        uploadByteLength = downsampledVolume.size() * sizeof(uint16_t);
    }

    WGPUTextureDescriptor desc{};
    desc.dimension = WGPUTextureDimension_3D;
    desc.size = WGPUExtent3D{textureWidth, textureHeight, depth};
    desc.format = WGPUTextureFormat_R16Float;
    desc.mipLevelCount = 1;
    desc.sampleCount = 1;
    desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    volumeTexture_ = wgpuDeviceCreateTexture(device_, &desc);
    std::printf("WebGPUDevice::volumeTexture: %ux%ux%u (downsampleFactor=%u)\n", textureWidth, textureHeight, depth,
                 downsampleFactor_);

    // Precomputed gradient volume -- same voxel dimensions as
    // volumeTexture_, baked by bakeGradientVolume() below once
    // volumeTextureView_ exists. StorageBinding for the compute pass's
    // write-only access, TextureBinding for the raymarch fragment
    // shader's later trilinear read.
    //
    // Mobile OOM mitigation: with downsampleFactor_ > 1, this texture
    // would be the single largest allocation this function makes
    // (RGBA16Float, 4x volumeTexture_'s own size, since it has 4x the
    // bytes-per-texel) for a benefit (cheaper per-step shading) that
    // matters far less than staying under a memory ceiling. A 1x1x1
    // placeholder keeps binding 6's bind-group-layout slot satisfied
    // (validation only checks sample type/dimension, not extent) without
    // the bake pass ever running -- fragmentMain falls back to
    // computeGradient() instead of sampling this texture when tfParams.z
    // signals downsampleFactor_ > 1 (see renderFrame()'s UBO population).
    // No StorageBinding usage needed here since the bake pass that would
    // need it is skipped below.
    WGPUTextureDescriptor gradientDesc{};
    gradientDesc.dimension = WGPUTextureDimension_3D;
    gradientDesc.size = downsampleFactor_ > 1 ? WGPUExtent3D{1, 1, 1} : WGPUExtent3D{width, height, depth};
    gradientDesc.format = WGPUTextureFormat_RGBA16Float;
    gradientDesc.mipLevelCount = 1;
    gradientDesc.sampleCount = 1;
    gradientDesc.usage = downsampleFactor_ > 1
                              ? WGPUTextureUsage_TextureBinding
                              : (WGPUTextureUsage_StorageBinding | WGPUTextureUsage_TextureBinding);
    gradientTexture_ = wgpuDeviceCreateTexture(device_, &gradientDesc);
    // Reports the actual chosen extent (gradientDesc.size), not just an
    // echo of the downsampleFactor input -- a test asserting on this line
    // catches a regression where the branch above stops honoring the flag
    // (e.g. always allocating full-size), which a pixel-only comparison of
    // the two modes' output would not.
    std::printf("WebGPUDevice::gradientTexture: %ux%ux%u\n", gradientDesc.size.width,
                 gradientDesc.size.height, gradientDesc.size.depthOrArrayLayers);

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = volumeTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, 0};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = textureWidth * static_cast<uint32_t>(sizeof(uint16_t));
    layout.rowsPerImage = textureHeight;

    WGPUExtent3D writeSize{textureWidth, textureHeight, depth};
    wgpuQueueWriteTexture(queue_, &dst, uploadData, uploadByteLength, &layout, &writeSize);
    renderGraph_.transition("volume", core::ResourceState::TransferDst);

    // Mask texture is created here (not lazily on the first applyMaskSlice
    // call) so the raymarch bind group always has a valid mask texture
    // view to reference, even before any segmentation slice has arrived --
    // PRD #5.3.2's decoupling model ("the volume renders immediately, mask
    // overlay fills in as slices arrive") requires the volume to be
    // drawable on its own. WebGPU zero-initializes new textures, so an
    // all-background (class 0) mask is already the correct initial state.
    WGPUTextureDescriptor maskDesc{};
    maskDesc.dimension = WGPUTextureDimension_3D;
    maskDesc.size = WGPUExtent3D{textureWidth, textureHeight, depth};
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

    WGPUTextureViewDescriptor gradientViewDesc{};
    gradientViewDesc.format = WGPUTextureFormat_RGBA16Float;
    gradientViewDesc.dimension = WGPUTextureViewDimension_3D;
    gradientViewDesc.mipLevelCount = 1;
    gradientViewDesc.arrayLayerCount = 1;
    gradientViewDesc.aspect = WGPUTextureAspect_All;
    gradientTextureView_ = wgpuTextureCreateView(gradientTexture_, &gradientViewDesc);

    // Bakes gradientTexture_ from the just-written volumeTexture_ -- must
    // run after both texture views above exist, before rebuildBindGroup()
    // references gradientTextureView_. Skipped in low-memory mode:
    // gradientTexture_ is a 1x1x1 placeholder
    // there, and dispatching a bake against it would be meaningless (the
    // shader falls back to computeGradient() instead of sampling it).
    if (downsampleFactor_ <= 1) {
        bakeGradientVolume(width, height, depth, spacingX, spacingY, spacingZ);
        std::printf("WebGPUDevice::gradientTexture: baked\n");
    } else {
        std::printf("WebGPUDevice::gradientTexture: bake skipped (downsampleFactor=%u)\n", downsampleFactor_);
    }

    currentVolumeId_ = volumeId;
    hasVolume_ = true;
    volumeWidth_ = textureWidth;
    volumeHeight_ = textureHeight;
    volumeDepth_ = depth;
    // Defaults the Slice2D view to Axial at the volume's middle slice --
    // mirrors frameCameraForVolume()'s own reset-defaults-on-load pattern
    // for the Orbit3D camera below. A new series' Sagittal/Coronal extents
    // are
    // unrelated to the previous one's, so keeping a stale non-Axial axis
    // selected across loads would show a slice index with no clear
    // relationship to the new volume.
    sliceAxis_ = kSliceAxisAxial;
    sliceIndex_ = depth > 0 ? depth / 2 : 0;

    frameCameraForVolume(width, height, depth, spacingX, spacingY, spacingZ);
    rebuildBindGroup();
    // A new volume replaces the geometry/orientation the accumulation
    // buffer's existing content was rendered from -- without this, its
    // first post-load frames would blend the new volume against
    // leftover pixels from whatever was loaded (or not) before.
    markAccumulationDirty();

    std::printf("WebGPUDevice::loadVolume: volumeId=%u %ux%ux%u loaded downsampleFactor=%u\n", volumeId, width,
                 height, depth, downsampleFactor_);
}

void WebGPUDevice::releaseVolumeResources() {
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
    if (gradientTextureView_) {
        wgpuTextureViewRelease(gradientTextureView_);
        gradientTextureView_ = nullptr;
    }
    if (gradientTexture_) {
        wgpuTextureRelease(gradientTexture_);
        gradientTexture_ = nullptr;
    }
}

void WebGPUDevice::releaseNativeVolumeResources() {
    if (nativeBindGroup_) {
        wgpuBindGroupRelease(nativeBindGroup_);
        nativeBindGroup_ = nullptr;
    }
    if (nativeVolumeTextureView_) {
        wgpuTextureViewRelease(nativeVolumeTextureView_);
        nativeVolumeTextureView_ = nullptr;
    }
    if (nativeVolumeTexture_) {
        wgpuTextureRelease(nativeVolumeTexture_);
        nativeVolumeTexture_ = nullptr;
    }
}

void WebGPUDevice::loadNativeVolume(uint32_t volumeId, void const* data, size_t byteLength, uint32_t width,
                                      uint32_t height, uint32_t depth, float spacingX, float spacingY,
                                      float spacingZ) {
    if (!ready_) {
        std::printf("WebGPUDevice::loadNativeVolume: device not ready, ignoring\n");
        return;
    }
    // Shares uboBuffer_/linearSampler_/maskTextureView_/lutTextureView_/
    // preintegratedLutTextureView_/gradientTextureView_ with the primary
    // volume's bind group (see this class's own header comment on
    // nativeVolumeTexture_) -- those must already exist.
    if (!lutTextureView_ || !maskTextureView_ || !gradientTextureView_ || !preintegratedLutTextureView_) {
        std::printf(
            "WebGPUDevice::loadNativeVolume: no primary volume loaded yet (shared LUT/mask/gradient textures "
            "don't exist), ignoring\n");
        return;
    }
    size_t const expected = static_cast<size_t>(width) * height * depth * sizeof(uint16_t);
    if (byteLength != expected) {
        std::printf("WebGPUDevice::loadNativeVolume: byteLength %zu != expected %zu, ignoring\n", byteLength,
                     expected);
        return;
    }

    releaseNativeVolumeResources();

    WGPUTextureDescriptor desc{};
    desc.dimension = WGPUTextureDimension_3D;
    desc.size = WGPUExtent3D{width, height, depth};
    desc.format = WGPUTextureFormat_R16Float;
    desc.mipLevelCount = 1;
    desc.sampleCount = 1;
    desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    nativeVolumeTexture_ = wgpuDeviceCreateTexture(device_, &desc);
    std::printf("WebGPUDevice::nativeVolumeTexture: %ux%ux%u\n", width, height, depth);

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = nativeVolumeTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, 0};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = width * static_cast<uint32_t>(sizeof(uint16_t));
    layout.rowsPerImage = height;

    WGPUExtent3D writeSize{width, height, depth};
    wgpuQueueWriteTexture(queue_, &dst, data, byteLength, &layout, &writeSize);

    WGPUTextureViewDescriptor viewDesc{};
    viewDesc.format = WGPUTextureFormat_R16Float;
    viewDesc.dimension = WGPUTextureViewDimension_3D;
    viewDesc.mipLevelCount = 1;
    viewDesc.arrayLayerCount = 1;
    viewDesc.aspect = WGPUTextureAspect_All;
    nativeVolumeTextureView_ = wgpuTextureCreateView(nativeVolumeTexture_, &viewDesc);

    // Same 7-entry layout as rebuildBindGroup()'s primary bind group --
    // only binding 1 (the volume texture) differs.
    std::array<WGPUBindGroupEntry, 7> entries{};
    entries[0].binding = 0;
    entries[0].buffer = uboBuffer_;
    entries[0].offset = 0;
    entries[0].size = sizeof(AxialSliceUBO);
    entries[1].binding = 1;
    entries[1].textureView = nativeVolumeTextureView_;
    entries[2].binding = 2;
    entries[2].sampler = linearSampler_;
    entries[3].binding = 3;
    entries[3].textureView = maskTextureView_;
    entries[4].binding = 4;
    entries[4].textureView = lutTextureView_;
    entries[5].binding = 5;
    entries[5].textureView = preintegratedLutTextureView_;
    entries[6].binding = 6;
    entries[6].textureView = gradientTextureView_;

    WGPUBindGroupDescriptor bgDesc{};
    bgDesc.layout = bindGroupLayout_;
    bgDesc.entryCount = entries.size();
    bgDesc.entries = entries.data();
    nativeBindGroup_ = wgpuDeviceCreateBindGroup(device_, &bgDesc);

    hasNativeVolume_ = true;
    nativeVolumeWidth_ = width;
    nativeVolumeHeight_ = height;
    nativeVolumeDepth_ = depth;
    nativeSpacingX_ = spacingX;
    nativeSpacingY_ = spacingY;
    nativeSpacingZ_ = spacingZ;
    // Defaults to the middle slice, same convention as loadVolume().
    nativeSliceIndex_ = depth > 0 ? depth / 2 : 0;
    (void)volumeId;  // Not tracked separately -- loadVolume()'s currentVolumeId_ already guards staleness
                      // for the same series; the native volume always loads alongside it, never independently.
}

void WebGPUDevice::applyMaskSlice(uint32_t volumeId, uint32_t sliceIndex, uint32_t width, uint32_t height,
                                   void const* data, size_t byteLength) {
    if (!hasVolume_ || volumeId != currentVolumeId_) {
        std::printf("WebGPUDevice::applyMaskSlice: stale volumeId=%u (current=%u), ignoring\n", volumeId,
                     currentVolumeId_);
        return;
    }
    // Validated against originalVolumeWidth_/originalVolumeHeight_, not
    // volumeWidth_/volumeHeight_ (the actual mask/volume texture size) --
    // an incoming slice always arrives at the source DICOM series'
    // resolution, since the AI Worker runs against that, unaware of any
    // internal low-memory-mode downsampling (see
    // originalVolumeWidth_/Height_'s own comment).
    if (width != originalVolumeWidth_ || height != originalVolumeHeight_) {
        std::printf("WebGPUDevice::applyMaskSlice: %ux%u doesn't match loaded volume %ux%u, ignoring\n",
                     width, height, originalVolumeWidth_, originalVolumeHeight_);
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

    // Mobile OOM mitigation: with downsampleFactor_ > 1, maskTexture_ was
    // created at the downsampled (volumeWidth_ x volumeHeight_) extent --
    // see loadVolume()'s own comment -- so an incoming full-resolution
    // slice needs the same nearest-neighbor downsample before writing.
    // depth=1 (a single Z-slice), so downsampleNearestXY's Z loop runs once.
    std::vector<uint8_t> downsampledSlice;
    void const* uploadData = data;
    size_t uploadByteLength = byteLength;
    if (downsampleFactor_ > 1) {
        uint32_t outWidth = 0;
        uint32_t outHeight = 0;
        downsampledSlice = downsampleNearestXY(static_cast<uint8_t const*>(data), width, height, 1,
                                                downsampleFactor_, outWidth, outHeight);
        uploadData = downsampledSlice.data();
        uploadByteLength = downsampledSlice.size() * sizeof(uint8_t);
    }

    WGPUTexelCopyTextureInfo dst{};
    dst.texture = maskTexture_;
    dst.mipLevel = 0;
    dst.origin = WGPUOrigin3D{0, 0, sliceIndex};
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = volumeWidth_ * static_cast<uint32_t>(sizeof(uint8_t));
    layout.rowsPerImage = volumeHeight_;

    WGPUExtent3D writeSize{volumeWidth_, volumeHeight_, 1};
    wgpuQueueWriteTexture(queue_, &dst, uploadData, uploadByteLength, &layout, &writeSize);
    renderGraph_.transition("mask", core::ResourceState::TransferDst);
    // A newly-applied mask slice changes what renderFrame() should draw
    // even if the camera/window/level haven't -- without this, its
    // contribution only blends in at whatever (possibly tiny, if the
    // volume has been sitting on screen for a while) weight
    // accumFrameIndex_ has already decayed to.
    markAccumulationDirty();

    std::printf("WebGPUDevice::applyMaskSlice: volumeId=%u slice=%u applied\n", volumeId, sliceIndex);
}

void WebGPUDevice::setWindowLevel(float center, float width) {
    windowCenter_ = center;
    windowWidth_ = width;
    markAccumulationDirty();
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
    threshold_ = preset.threshold;
    thresholdMax_ = preset.thresholdMax;
    // Every fixed preset shares one plain grayscale ramp now (see
    // ColormapPreset's own comment) -- rewritten here regardless of which
    // preset this call, since a prior Custom selection (setCustomColormap())
    // may have left both LUTs holding whatever colors the user picked.
    writeLutColors(kGrayscaleLow, kGrayscaleHigh);
    writePreintegratedLutColors(kGrayscaleLow, kGrayscaleHigh);
    markAccumulationDirty();
}

void WebGPUDevice::orbitCamera(float deltaYawPixels, float deltaPitchPixels) {
    if (!hasVolume_ || viewMode_ != kViewModeOrbit3D) {
        std::printf("WebGPUDevice::orbitCamera: no volume loaded or not in Orbit3D mode, ignoring\n");
        return;
    }

    // Vertical drag uses trackball convention (drag down -> orbit up and over
    // the top, matching Blender/Google Earth/most 3D-viewer orbit controls) --
    // += here, unlike yaw's -=, since screen-space dy grows downward but the
    // expected orbit response is the opposite sign of horizontal drag.
    cameraYaw_ -= deltaYawPixels * kOrbitSensitivity;
    cameraPitch_ += deltaPitchPixels * kOrbitSensitivity;
    // Gimbal-flip guard -- yaw is intentionally left unclamped (free spin).
    cameraPitch_ = std::clamp(cameraPitch_, glm::radians(-89.0F), glm::radians(89.0F));

    updateCameraMatrices();
    markAccumulationDirty();
}

void WebGPUDevice::zoomCamera(float wheelDeltaSign) {
    if (!hasVolume_ || viewMode_ != kViewModeOrbit3D) {
        std::printf("WebGPUDevice::zoomCamera: no volume loaded or not in Orbit3D mode, ignoring\n");
        return;
    }

    glm::vec3 const halfExtent = (aabbMax_ - aabbMin_) * 0.5F;
    float const extent = glm::length(halfExtent);

    // Adaptive step (faster when already far away, via cameraDistance_'s
    // own contribution), with a floor relative to this volume's own size
    // -- world units here are physical mm and vary per volume, so a fixed
    // absolute floor wouldn't generalize.
    float const zoomSpeed = std::max(extent * 0.05F, cameraDistance_ * 0.08F);
    cameraDistance_ -= wheelDeltaSign * zoomSpeed;
    cameraDistance_ = std::clamp(cameraDistance_, extent * 0.3F, extent * 10.0F);

    updateCameraMatrices();
    markAccumulationDirty();
}

void WebGPUDevice::setViewMode(uint32_t mode) {
    if (mode != kViewModeOrbit3D && mode != kViewModeSlice2D && mode != kViewModeNativeSlice2D) {
        std::printf("WebGPUDevice::setViewMode: invalid mode=%u, ignoring\n", mode);
        return;
    }
    viewMode_ = mode;
    markAccumulationDirty();
}

void WebGPUDevice::setSliceIndex(uint32_t index) {
    if (!hasVolume_) {
        std::printf("WebGPUDevice::setSliceIndex: no volume loaded, ignoring\n");
        return;
    }
    uint32_t maxIndex;
    if (sliceAxis_ == kSliceAxisSagittal) {
        maxIndex = volumeWidth_ - 1;
    } else if (sliceAxis_ == kSliceAxisCoronal) {
        maxIndex = volumeHeight_ - 1;
    } else {
        maxIndex = volumeDepth_ - 1;
    }
    sliceIndex_ = std::min(index, maxIndex);
}

void WebGPUDevice::setSliceAxis(uint32_t axis) {
    if (!hasVolume_) {
        std::printf("WebGPUDevice::setSliceAxis: no volume loaded, ignoring\n");
        return;
    }
    if (axis != kSliceAxisAxial && axis != kSliceAxisSagittal && axis != kSliceAxisCoronal) {
        std::printf("WebGPUDevice::setSliceAxis: invalid axis=%u, ignoring\n", axis);
        return;
    }
    sliceAxis_ = axis;
    // Resets to the middle of the new axis's own range -- the previous
    // index may be out of range (e.g. width vs. depth) or anatomically
    // meaningless for the new axis (see setSliceAxis's Device.hpp comment).
    uint32_t dimension;
    if (axis == kSliceAxisSagittal) {
        dimension = volumeWidth_;
    } else if (axis == kSliceAxisCoronal) {
        dimension = volumeHeight_;
    } else {
        dimension = volumeDepth_;
    }
    sliceIndex_ = dimension > 0 ? dimension / 2 : 0;
}

void WebGPUDevice::setNativeSliceIndex(uint32_t index) {
    if (!hasNativeVolume_) {
        std::printf("WebGPUDevice::setNativeSliceIndex: no native volume loaded, ignoring\n");
        return;
    }
    nativeSliceIndex_ = std::min(index, nativeVolumeDepth_ - 1);
}

void WebGPUDevice::setQualityTier(uint32_t tier) {
    if (tier >= kQualityTiers.size()) {
        std::printf("WebGPUDevice::setQualityTier: invalid tier=%u (max %zu), ignoring\n", tier,
                     kQualityTiers.size() - 1);
        return;
    }
    qualityTier_ = tier;
    markAccumulationDirty();
}

void WebGPUDevice::setShadingMode(uint32_t mode) {
    if (mode > 2) {
        std::printf("WebGPUDevice::setShadingMode: invalid mode=%u (max 2), ignoring\n", mode);
        return;
    }
    shadingMode_ = mode;
    markAccumulationDirty();
}

void WebGPUDevice::setExtinction(float extinction) {
    extinction_ = std::max(extinction, 0.0F);
    markAccumulationDirty();
}

void WebGPUDevice::setDensityScale(float scale) {
    densityScale_ = std::max(scale, 0.0F);
    markAccumulationDirty();
}

void WebGPUDevice::setThreshold(float threshold) {
    threshold_ = std::clamp(threshold, 0.0F, 1.0F);
    markAccumulationDirty();
}

void WebGPUDevice::setThresholdMax(float thresholdMax) {
    thresholdMax_ = std::clamp(thresholdMax, 0.0F, 1.0F);
    markAccumulationDirty();
}

void WebGPUDevice::setClipBox(float minX, float minY, float minZ, float maxX, float maxY, float maxZ) {
    glm::vec3 requestedMin{minX, minY, minZ};
    glm::vec3 requestedMax{maxX, maxY, maxZ};
    // Clamp to the volume's own AABB per axis, then guarantee min<=max --
    // a caller passing a swapped or out-of-range pair shouldn't be able to
    // produce a degenerate/inverted clip box.
    for (int axis = 0; axis < 3; ++axis) {
        requestedMin[axis] = std::clamp(requestedMin[axis], aabbMin_[axis], aabbMax_[axis]);
        requestedMax[axis] = std::clamp(requestedMax[axis], aabbMin_[axis], aabbMax_[axis]);
        if (requestedMin[axis] > requestedMax[axis]) {
            std::swap(requestedMin[axis], requestedMax[axis]);
        }
    }
    clipMin_ = requestedMin;
    clipMax_ = requestedMax;
    markAccumulationDirty();
}

void WebGPUDevice::setGradientOpacityStrength(float strength) {
    gradientOpacityStrength_ = std::clamp(strength, 0.0F, 1.0F);
    markAccumulationDirty();
}

void WebGPUDevice::setOcclusionEnabled(bool enabled) {
    occlusionEnabled_ = enabled;
    markAccumulationDirty();
}

void WebGPUDevice::setMaskOverlayAlpha(float alpha) {
    maskOverlayAlpha_ = std::clamp(alpha, 0.0F, 1.0F);
    markAccumulationDirty();
}

void WebGPUDevice::setMaskOverlayEnabled(bool enabled) {
    maskOverlayEnabled_ = enabled;
    markAccumulationDirty();
}

void WebGPUDevice::setCustomColormap(float lowR, float lowG, float lowB, float highR, float highG, float highB) {
    auto toByte = [](float value) -> uint8_t { return static_cast<uint8_t>(std::clamp(value, 0.0F, 1.0F) * 255.0F); };
    customLowColor_ = ColorRGB{toByte(lowR), toByte(lowG), toByte(lowB)};
    customHighColor_ = ColorRGB{toByte(highR), toByte(highG), toByte(highB)};
    // Custom is not one of kColormapPresets' indices -- write both LUTs
    // directly from the custom colors, matching what setColormapPreset()
    // does for a fixed preset (window/level is deliberately left
    // untouched, per this method's Device.hpp doc comment).
    writeLutColors(customLowColor_, customHighColor_);
    writePreintegratedLutColors(customLowColor_, customHighColor_);
    markAccumulationDirty();
}

void WebGPUDevice::setBackgroundColor(float r, float g, float b) {
    backgroundColor_ = glm::vec3{std::clamp(r, 0.0F, 1.0F), std::clamp(g, 0.0F, 1.0F), std::clamp(b, 0.0F, 1.0F)};
    markAccumulationDirty();
}

void WebGPUDevice::markAccumulationDirty() {
    accumFrameIndex_ = 0.0F;
}

void WebGPUDevice::resize(uint32_t width, uint32_t height) {
    // A detached/hidden canvas can report a 0x0 ResizeObserver entry --
    // reject rather than configuring a zero-sized surface (undefined
    // behavior in WebGPU) or dividing by zero in the aspect-ratio calc
    // below.
    if (width == 0 || height == 0) {
        std::printf("WebGPUDevice::resize: ignoring degenerate %ux%u\n", width, height);
        return;
    }
    canvasWidth_ = width;
    canvasHeight_ = height;

    // device_ is null before onDeviceRequested() has fired -- resize() is
    // allowed to be called that early (Device.hpp's header comment), so
    // just remember the new dimensions; configureSurface() (called once
    // from onDeviceRequested()) will use whatever canvasWidth_/
    // canvasHeight_ already hold at that point.
    if (device_) {
        configureSurface();
        // Only once the composite pipeline exists (createCompositePipeline()
        // may not have run yet if resize() is called very early -- see
        // Device.hpp's "safe to call before the device is ready" note).
        if (compositeBindGroupLayout_) {
            createAccumulationResources();
        }
    }
    updateCameraMatrices();
    markAccumulationDirty();
}

void WebGPUDevice::setRenderPaused(bool paused) {
    // Deliberately a bare setter -- no markAccumulationDirty() call, so
    // resuming continues accumulating from where it left off (Device.hpp's
    // own header comment on why).
    pauseRendering_ = paused;
}

FrameStatsSnapshot WebGPUDevice::getFrameStats() const {
    return FrameStatsSnapshot{
        frameStats_.lastFrameTimeMs(),
        frameStats_.avgFrameTimeMs(),
        frameStats_.fps(),
    };
}

HardwareInfo WebGPUDevice::getHardwareInfo() const {
    return hardwareInfo_;
}

GpuTimingSnapshot WebGPUDevice::getGpuTiming() const {
    return GpuTimingSnapshot{timestampQuerySupported_, gpuRaymarchMs_, gpuCompositeMs_, gpuAxialMs_};
}

DeviceLossSnapshot WebGPUDevice::getDeviceLossState() const {
    return DeviceLossSnapshot{
        deviceLost_, deviceLossReason_, deviceLossMessage_, hasUncapturedError_, uncapturedErrorMessage_,
    };
}

void WebGPUDevice::clearUncapturedError() {
    hasUncapturedError_ = false;
    uncapturedErrorMessage_.clear();
}

void WebGPUDevice::beginTimestampReadback(uint32_t queryCount) {
    if (timestampReadbackPending_) {
        // Previous readback hasn't resolved yet -- skip this frame's rather
        // than queuing up (WebGPU disallows mapping a buffer that's already
        // being mapped). Last frame's numbers stay displayed.
        return;
    }
    timestampReadbackPending_ = true;
    pendingTimestampQueryCount_ = queryCount;

    WGPUBufferMapCallbackInfo mapCallbackInfo{};
    mapCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    mapCallbackInfo.callback = &WebGPUDevice::onTimestampBufferMapped;
    mapCallbackInfo.userdata1 = this;
    wgpuBufferMapAsync(timestampReadbackBuffer_, WGPUMapMode_Read, 0, queryCount * sizeof(uint64_t), mapCallbackInfo);
}

void WebGPUDevice::onTimestampBufferMapped(WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1,
                                            void* /*userdata2*/) {
    auto* self = static_cast<WebGPUDevice*>(userdata1);
    self->timestampReadbackPending_ = false;
    if (status != WGPUMapAsyncStatus_Success) {
        logStringView("WebGPUDevice: timestamp buffer map failed", message);
        return;
    }

    // wgpuBufferGetMappedRange() (mutable) is write-mode only -- Dawn's
    // emdawnwebgpu shim asserts `mPendingMapRequest.mode ==
    // WGPUMapMode_Write` and returns nullptr otherwise. This buffer is
    // mapped WGPUMapMode_Read, so the const-returning accessor is the
    // correct one.
    size_t const byteSize = self->pendingTimestampQueryCount_ * sizeof(uint64_t);
    auto const* timestamps =
        static_cast<uint64_t const*>(wgpuBufferGetConstMappedRange(self->timestampReadbackBuffer_, 0, byteSize));

    // WebGPU timestamp values are already in nanoseconds (unlike Vulkan,
    // which needs VkPhysicalDeviceLimits::timestampPeriod to convert ticks
    // -- no such conversion needed here).
    if (self->pendingTimestampQueryCount_ >= 2) {
        float const firstPassMs = static_cast<float>(timestamps[1] - timestamps[0]) / 1.0e6F;
        if (self->pendingTimestampQueryCount_ == 2) {
            // Only the axial-slice pass ran this frame (slots 0/1 are its
            // begin/end -- see createTimestampQuery()'s header comment).
            // Clear the raymarch/composite side rather than leaving a stale
            // nonzero value sitting there -- overlays (statsOverlay.ts, the
            // wasm_smoke shell) pick which pass to display by whichever
            // value is nonzero, so a lingering old raymarch number from
            // before a view-mode switch would keep showing instead of this
            // frame's real axial measurement.
            self->gpuAxialMs_ = firstPassMs;
            self->gpuRaymarchMs_ = 0.0F;
            self->gpuCompositeMs_ = 0.0F;
        } else {
            self->gpuRaymarchMs_ = firstPassMs;
            self->gpuAxialMs_ = 0.0F;
        }
    }
    if (self->pendingTimestampQueryCount_ >= 4) {
        self->gpuCompositeMs_ = static_cast<float>(timestamps[3] - timestamps[2]) / 1.0e6F;
    }

    wgpuBufferUnmap(self->timestampReadbackBuffer_);
}

}  // namespace omnimed3d::rhi::webgpu
