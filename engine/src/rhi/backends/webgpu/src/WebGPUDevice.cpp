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

// Pre-integrated (front,back) transfer-function table (§6.1) -- see
// writePreintegratedLut()'s header comment for the bake algorithm.
constexpr uint32_t kPreintegratedLutSize = 256;
constexpr uint32_t kPreintegrationSubSamples = 16;

// REQ-R06 interactive camera tuning -- rad/px, matching Mini-Engine-
// reference's WASM/mobile-tuned Camera::rotate() sensitivity (this is a
// browser-only target, so their separate native-build constant doesn't
// apply here).
constexpr float kOrbitSensitivity = 0.0025F;

// Nearest-neighbor subsample of a WxHxD (or single-slice, D=1) buffer to
// (ceil(W/factor))x(ceil(H/factor))xD, in place of box-averaging: the
// volume's uint16_t buffer is already float16-bit-pattern-encoded
// upstream (viewer/src/workers/parse-worker/src/halfFloat.ts) -- treating
// it as an opaque value and picking one texel per block needs no float16
// codec in the Engine, whereas averaging would. Mask data (uint8_t) is
// discrete class indices (REQ-C01), where averaging labels is meaningless
// regardless -- nearest-neighbor is the correct choice there on its own
// terms. Ceiling division on the output extent handles odd input
// dimensions; the source-index clamp guards the last output row/column
// when width/height isn't an exact multiple of factor.
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
    glm::vec4 rayParams;      // x=stepSize, y=maxSteps, z=extinction, w unused
    glm::vec4 window;         // x=center, y=width, zw unused
    glm::vec4 maskParams;     // x=overlayEnabled, y=overlayAlpha, zw unused
    glm::vec4 shadingParams;    // xyz=light direction (world, normalized), w=shading mode (0=off, 1=on, 2=on-flat -- issue #81)
    glm::vec4 jitterParams;     // x=accumFrameIndex, y=accumulation enabled (0/1), zw unused
    glm::vec4 clipMin;          // xyz, world mm -- raymarch traversal bound (§6.4)
    glm::vec4 clipMax;          // xyz, world mm -- raymarch traversal bound (§6.4)
    glm::vec4 occlusionParams;  // x=DOS enabled (0/1), y=strength, zw unused
    glm::vec4 tfParams;         // x=threshold, y=gradient-opacity strength, z=low-memory gradient fallback (0/1),
                                // w=thresholdMax (upper cutoff, §5.3 follow-up)
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

// Mirrors AxialSliceUBO in engine/shaders/src/axial_slice.slang (issue
// #37) -- deliberately a separate, smaller struct rather than reusing
// RaymarchUBO: the 2D slice view needs no camera/AABB/ray-march fields,
// and forcing one shared struct would make RaymarchUBO's own "mirrors the
// shader field for field" comment above untrue for whichever shader
// didn't declare all its fields.
struct AxialSliceUBO {
    glm::vec4 sliceParams;  // x=sliceIndex (raw voxel index), y=windowCenter, z=windowWidth, w unused
    glm::vec4 maskParams;   // x=overlayEnabled, y=overlayAlpha, zw unused
    // "Contain" letterbox fit (issue #40 follow-up) -- see
    // axial_slice.slang's own comment on this field for the full
    // rationale. x/y are NDC scale factors, computed fresh every frame in
    // renderFrame() from the volume's physical aspect ratio (aabbMax_ -
    // aabbMin_) vs. canvasWidth_/canvasHeight_'s aspect ratio.
    glm::vec4 fitParams;
};

static_assert(offsetof(AxialSliceUBO, sliceParams) == 0);
static_assert(offsetof(AxialSliceUBO, maskParams) == 16);
static_assert(offsetof(AxialSliceUBO, fitParams) == 32);
static_assert(sizeof(AxialSliceUBO) == 48);

// View modes for WebGPUDevice::setViewMode() (issue #37).
constexpr uint32_t kViewModeOrbit3D = 0;
constexpr uint32_t kViewModeAxialSlice2D = 1;

// Baseline clinical window/level presets (REQ-R03) -- center/width values
// sourced from Mini-Engine-reference's medical-volume primer doc, per PRD
// Appendix A's explicit "referencing Mini-Engine's preset values"
// instruction. lowColor/highColor (docs/current/
// RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md §4.2) give each preset its own
// LUT color ramp instead of the original shared grayscale -- alpha still
// ramps linearly with normalized density regardless of preset (see
// writeLutPreset()), so only hue/tint distinguishes presets, not opacity
// behavior. ColorRGB itself now lives in WebGPUDevice.hpp -- shared with
// setCustomColormap()'s (§5.3) writeLutColors()/writePreintegratedLutColors().
struct ColormapPreset {
    float center;
    float width;
    ColorRGB lowColor;
    ColorRGB highColor;
    // User request, 2026-08-27: per-preset default Threshold band (§5.3's
    // `n < threshold || n > thresholdMax -> alpha = 0` cutoff,
    // volume_raymarch.slang), applied by setColormapPreset() below.
    // Empirically tuned (screenshot comparison, not derived analytically)
    // against the LIDC-IDRI demo CTs in 3D Orbit mode -- without this,
    // every preset saturated to opaque at the skin/fat surface before the
    // ray ever reached the tissue the preset is named for, so switching
    // presets only re-tinted the same body-surface silhouette.
    //
    // Bone: skin/fat sit at n~0.3, bone at n>=0.4 within Bone's -450..1050
    // HU window -- threshold=0.4 cuts skin while keeping bone (0.3 still
    // mostly showed skin, 0.5 started eroding cortical bone surfaces).
    // thresholdMax left at 1.0 (no upper cutoff needed).
    //
    // Lung: needed *both* ends of the band, for a reason that isn't the
    // mirror image of Bone's -- found by rendering `n` itself as grayscale
    // (bypassing the LUT) to see what density the visible "surface" in a
    // plain 3D Orbit render actually sat at, since screenshot sweeps of
    // thresholdMax alone (0.95 down to 0.3) changed *nothing* visible,
    // which the "chest wall is denser than lung" theory alone couldn't
    // explain. What that debug render showed: the surface sat at a *low*
    // n (~0.15-0.2), not the high n skin/fat should occupy. Root cause --
    // Lung's window floor (-1350 HU) is far enough below real background
    // air (~-1000 HU, n~0.23 in this window) that air itself was *not*
    // fully cut (alpha isn't proportionally tiny either: with the default
    // extinction=8, n=0.23 alone gives a substantial per-step alpha, and
    // Beer-Lambert compounds that over the hundreds of steps a ray spends
    // crossing the AABB's own empty margin around the patient) -- so the
    // ray was saturating to opaque from background air alone, well before
    // it ever reached the patient, let alone the lung inside. threshold
    // =0.25 (raw HU ~ -975, just above real background air and the most
    // aerated lung tissue's own floor) cuts that air out; thresholdMax
    // then cuts the chest wall the way it would for any denser-occluder
    // preset, so what's left visible is the band in between -- the
    // aerated lung fields and their internal vessel/airway-wall detail.
    // 0.85 (raw HU ~ -75) alone was enough to remove the reported "solid
    // cylinder" look, but a loaded segmentation mask (§5.3.2) still wasn't
    // visible anywhere in 3D Orbit at that value -- the mask lives deeper,
    // inside the lung parenchyma itself, and the still-fairly-wide 0.25-0.85
    // band includes enough intermediate soft-tissue density (fat, vessel
    // walls, etc.) that accum.a was still saturating before the ray got
    // that far in. Narrowed to 0.45 (raw HU ~ -825) by re-testing with a
    // real loaded lungmask R231 mask each step -- 0.5 still showed no mask
    // anywhere, 0.4/0.45 both exposed it (confirmed via screenshot, a red
    // patch visible from the volume's top). This band improves the
    // reported "solid cylinder"/invisible-mask symptoms (confirmed via
    // screenshot); it does not by itself produce a textbook two-lung-
    // fields silhouette from every angle in a plain outside 3D Orbit view
    // -- a ray through the thicker lateral chest wall still saturates
    // before reaching the mask, only a ray through a thinner path (e.g.
    // near the top of the volume) gets far enough. The 2D Slice view
    // (axial_slice.slang, no threshold band
    // involved at all) already renders lung fields perfectly, confirming
    // the window/level values themselves were never the problem. Getting
    // the same clarity in 3D from an unclipped outside view is a transfer-
    // function-shape problem (a single linear alpha-vs-n ramp can't cut a
    // denser layer to zero while keeping a less-dense one partially
    // visible AND showing its internal detail) beyond what a threshold
    // band alone can fix -- Clip box is today's workaround for actually
    // looking inside.
    //
    // Brain: skull (if present in the scan) clamps to n=1, above brain
    // matter's ~0.25-0.56 -- the same "occluder is denser than target"
    // shape as Lung, so a thresholdMax *could* help the same way, but none
    // of this repo's demo CTs are head scans, so there's no real data to
    // empirically tune or verify a value against (the mistake this same
    // comment already warns about avoiding for Lung/Brain before this
    // threshold band existed). Left at 1.0 (unfixed) rather than guessed.
    float threshold;
    float thresholdMax;
};

constexpr std::array<ColormapPreset, 5> kColormapPresets{{
    {-600.0F, 1500.0F, {12, 24, 46}, {198, 224, 255}, 0.25F, 0.45F},  // 0: Lung -- cool blue
    {300.0F, 1500.0F, {46, 28, 12}, {255, 236, 199}, 0.4F, 1.0F},    // 1: Bone -- warm ivory
    {40.0F, 400.0F, {40, 12, 12}, {255, 176, 156}, 0.0F, 1.0F},      // 2: Soft Tissue -- warm red
    {40.0F, 80.0F, {18, 18, 22}, {230, 222, 214}, 0.0F, 1.0F},       // 3: Brain -- neutral warm gray
    {40.0F, 400.0F, {12, 12, 12}, {245, 245, 245}, 0.0F, 1.0F},      // 4: Grayscale (default) -- no
                                                                      // color tint, same window/level
                                                                      // as Soft Tissue, traditional
                                                                      // CT-film look
}};
constexpr uint32_t kDefaultColormapPreset = 4;

// REQ-R04 quality/step-count tiers -- WebGPUDevice::setQualityTier().
// stepsAcrossDiagonal sizes stepSize (diagonal / this); maxSteps is a
// safety-margin multiple of that (1.33x, matching the previous fixed
// 512/384 ratio) so grazing rays that need more than "diagonal / stepSize"
// steps still get to traverse the full box before hitting the loop's own
// cap. Medium reproduces the engine's original fixed behavior exactly
// (diagonal/384, 512 steps) so this is a strict generalization, not a
// behavior change, for anyone who never touches the new control.
struct QualityTier {
    float stepsAcrossDiagonal;
    float maxSteps;
};

constexpr std::array<QualityTier, 3> kQualityTiers{{
    {192.0F, 256.0F},   // 0: Low
    {384.0F, 512.0F},   // 1: Medium (default, matches the old hardcoded values)
    {768.0F, 1024.0F},  // 2: High
}};
constexpr uint32_t kDefaultQualityTier = 1;

// Fixed world-space light direction for gradient-based Lambert shading
// (setShadingMode()) -- a camera-independent key light (not exposed as
// a setter this branch; ambient/diffuse strength are likewise fixed
// constants in the shader itself). Chosen off-axis from the default
// camera framing (frameCameraForVolume()'s 35deg yaw / 25deg pitch) so
// shaded volumes show visible form from the default view, not a flat
// silhouette.
const glm::vec3 kLightDirection = glm::normalize(glm::vec3{0.4F, -0.6F, 0.7F});

// Anisotropic-spacing step-size guard (docs/current/
// RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md §6.6): the raymarch step size
// is otherwise isotropic in world mm (derived from the AABB diagonal),
// which can undersample a volume's finest axis on thick-slice/anisotropic
// data. Clamping stepSize to at most 1.5x the finest axis's physical
// spacing keeps thin structures along that axis from being stepped over
// entirely; maxSteps is then grown (see renderFrame()) so a shrunk step
// still reaches the far face, capped here so worst-case anisotropy can't
// produce an unbounded per-pixel loop.
constexpr float kFinestAxisStepMultiplier = 1.5F;
constexpr float kMaxRayStepsHardCap = 2048.0F;

// Caps accumFrameIndex_'s growth (mirrors Mini-Engine-reference's M4 v2
// "Accumulation-N cap" lesson, docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
// §6.5): the temporal blend weight is 1/(accumFrameIndex_+1), which decays
// toward zero forever if left uncapped -- after enough idle
// requestAnimationFrame ticks (easily thousands within a few seconds),
// any genuinely new content (e.g. a mask slice arriving asynchronously
// after the volume has already been sitting on screen for a while) would
// blend in with a weight too small to survive 8-bit swapchain
// quantization, silently "freezing" the displayed image. Capping means
// the running average always has at least 1/(kMaxAccumFrames+1) weight on
// the newest frame.
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

    // `timestamp-query` is optional (rhi::Device::getGpuTiming's header
    // comment) -- only request it if the adapter actually supports it, and
    // remember the result so the rest of this class knows whether to create
    // the query set / write timestamps at all. Feature detection here, not
    // just at device-creation time, matches CLAUDE.md #8's "feature
    // detection and activation are different facts" principle -- checking
    // now is what makes the later "activation" (creating the query set)
    // correct instead of a guess.
    self->timestampQuerySupported_ = wgpuAdapterHasFeature(adapter, WGPUFeatureName_TimestampQuery) != 0U;

    // Default maxBufferSize (256 MiB) is too small for gradientTexture_
    // (issue #81's own follow-up) on a volume of any real clinical size --
    // Dawn's internal lazy-clear-before-first-use for a storage texture
    // that size needs a staging buffer as large as the texture itself,
    // which silently failed validation against the default limit
    // (confirmed via a real "Buffer size ... exceeds the max buffer size
    // limit" console warning firing every frame, not assumed) and left
    // the raymarch output black. Requesting more than the default is safe
    // -- wgpuAdapterGetLimits() reports what this adapter can actually
    // support, and this file never asks for more than that (see below), so
    // a weaker adapter that genuinely can't go past the default still gets
    // exactly the default (feature-detected here, matching this file's own
    // `timestamp-query` handling immediately above, not just assumed
    // available).
    //
    // Bug fix, 2026-08-27: a fixed 512 MiB desired ceiling (this constant's
    // prior value) covered the original single demo CT's ~266 MiB gradient
    // texture (RGBA16Float, 4x the R16Float volume texture's own size) but
    // not LIDC-IDRI-0002's 261-slice series added since (512x512x261 voxels
    // -> a ~547 MiB gradient texture, confirmed via a real "Buffer size
    // 547356672 exceeds the max buffer size limit 536870912" console error,
    // not assumed) -- silently reproducing the exact bug this comment
    // already describes, just at a larger volume size. Rather than pick
    // another fixed number that the next larger volume can just as easily
    // exceed again, request the adapter's own reported ceiling directly --
    // requiredLimits only asks Dawn to *guarantee* a limit already reported
    // as supported, it doesn't preallocate anything, so there's no cost to
    // asking for all of it up front, and it scales automatically with
    // whatever this adapter can actually do.
    WGPULimits adapterLimits = WGPU_LIMITS_INIT;
    wgpuAdapterGetLimits(adapter, &adapterLimits);
    WGPULimits requiredLimits = WGPU_LIMITS_INIT;
    requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;

    WGPURequestDeviceCallbackInfo deviceCallbackInfo{};
    deviceCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    deviceCallbackInfo.callback = &WebGPUDevice::onDeviceRequested;
    deviceCallbackInfo.userdata1 = self;

    // Must outlive the wgpuAdapterRequestDevice() call below -- declaring
    // this inside the if-block and pointing deviceDesc.requiredFeatures at
    // it left a dangling pointer once the block's closing brace ended the
    // array's lifetime, since the request call itself happens after that
    // brace. Emscripten's JS glue reads through the pointer when it
    // marshals deviceDesc into a real GPUDeviceDescriptor, so a stale/
    // garbage stack value there surfaced as a browser-side "requiredFeatures
    // ... is not a valid enum value of type GPUFeatureName" TypeError
    // instead of a native crash.
    WGPUFeatureName const requiredFeatures[1] = {WGPUFeatureName_TimestampQuery};

    WGPUDeviceDescriptor deviceDesc{};
    deviceDesc.requiredLimits = &requiredLimits;
    if (self->timestampQuerySupported_) {
        deviceDesc.requiredFeatureCount = 1;
        deviceDesc.requiredFeatures = requiredFeatures;
    }
    // Mobile OOM mitigation (rhi::Device::getDeviceLossState) -- registers
    // both callbacks on this same descriptor rather than a separate
    // post-creation setter call, since WGPUDeviceDescriptor is where
    // Dawn's newer CallbackInfo-based API expects them. AllowSpontaneous
    // is safe here for the same reason as callbackInfo.mode above (no
    // ASYNCIFY in this engine).
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

    // vendor/architecture/device/description are WGPUStringView in this
    // emsdk's actual compiled-against header (the emdawnwebgpu port package
    // at cache/ports/emdawnwebgpu/, not the older copy under
    // cache/sysroot/include -- confirmed by hitting a real compile error
    // from assuming the sysroot copy's plain char const* shape, then
    // checking the header the compiler actually used). Same .data/.length
    // shape logStringView() above already handles for the async-callback
    // message params. Dawn allocates the backing storage;
    // wgpuAdapterInfoFreeMembers() releases it once copied into
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

// Writes kColormapPresets[presetId]'s color ramp into lutTexture_ (§4.2) --
// r/g/b lerp from lowColor to highColor across the ramp, alpha keeps the
// original linear-with-density ramp (a=t) regardless of preset, so only
// hue changes, not the existing opacity-vs-density behavior. Called from
// createSamplerAndLut() (initial default preset) and setColormapPreset()
// (every subsequent preset click) -- presetId is assumed already
// bounds-checked by the caller.
void WebGPUDevice::writeLutPreset(uint32_t presetId) {
    ColormapPreset const& preset = kColormapPresets[presetId];
    writeLutColors(preset.lowColor, preset.highColor);
}

// Shared by writeLutPreset() (the 4 fixed presets) and setCustomColormap()
// (§5.3's 5th, user-defined preset) -- see writeLutPreset()'s own header
// comment for the ramp/alpha semantics, unchanged here.
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

// Bakes kColormapPresets[presetId] into preintegratedLutTexture_ (§6.1,
// Engel et al. "High-Quality Pre-Integrated Volume Rendering"). For every
// (front, back) classification-value pair, numerically (trapezoidal)
// integrates the segment assuming density varies linearly between them,
// storing:
//   rgb = average color across the segment, weighted by local absorption
//   a   = "sBar", the average classification value across the segment
//         (NOT scaled by extinction -- tau(s) = extinction*s is linear in
//         s, so the extinction factor cancels out of the average and can
//         stay a runtime-read UBO value; see volume_raymarch.slang's
//         `alpha = 1 - exp(-extinction * sBar * stepSize)`). Note for a
//         future branch: if a non-extinction-proportional feature (e.g. a
//         hard threshold cutoff) is ever added to the absorption model,
//         this bake must incorporate it directly rather than assuming
//         tau(s)=s stays the whole shape -- shape and extinction would no
//         longer factor apart cleanly.
// Degenerates to the original single-point classification exactly when
// front==back (no segment to integrate over). Only rebaked on a preset
// (or future custom-color) change, not per frame or per window/level
// change -- see setColormapPreset().
void WebGPUDevice::writePreintegratedLut(uint32_t presetId) {
    ColormapPreset const& preset = kColormapPresets[presetId];
    writePreintegratedLutColors(preset.lowColor, preset.highColor);
}

// Shared by writePreintegratedLut() (the 4 fixed presets) and
// setCustomColormap() (§5.3's 5th, user-defined preset) -- see
// writePreintegratedLut()'s own header comment for the bake algorithm,
// unchanged here.
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
    // Constant/OneMinusConstant, not the shader-alpha-driven blend this
    // used before jitter+temporal-accumulation existed (§6.5) --
    // wgpuRenderPassEncoderSetBlendConstant() lets renderFrame() drive a
    // per-frame temporal blend weight (1/(accumFrameIndex_+1) for the
    // raymarch pass into accumulationTexture_, always 1.0 -- a full
    // overwrite -- for the axial-slice pass into the swapchain, which
    // doesn't participate in accumulation). Both shaders now resolve
    // their own volume-opacity-vs-background compositing internally and
    // always output alpha=1 (see volume_raymarch.slang's fragmentMain
    // header comment) specifically so this blend stage is purely a
    // temporal weight, not entangled with per-pixel volume alpha.
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

    // Shared by both pipelines (issue #37) -- both shaders declare the
    // exact same 6-entry layout (§6.1 added binding 5's pre-integrated
    // LUT, declared but unused by axial_slice.slang -- see its own
    // comment), see createRenderPipelineFor()'s header comment for why one
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

    // Precomputed gradient volume (issue #81's own follow-up,
    // gradient_bake.slang) -- see volume_raymarch.slang's own binding-6
    // comment. Sampled trilinearly (linearSampler_, entry 2 above), so
    // Float (filterable), not UnfilterableFloat.
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

    // pipeline_ (raymarch) now targets accumulationTexture_ (§6.5,
    // RGBA16Float), not the swapchain -- axialPipeline_ still draws
    // directly to the swapchain (BGRA8Unorm). See createRenderPipelineFor's
    // header comment for why this format must match exactly.
    pipeline_ = createRenderPipelineFor(shaderModule_, WGPUTextureFormat_RGBA16Float);
    axialPipeline_ = createRenderPipelineFor(axialShaderModule_, WGPUTextureFormat_BGRA8Unorm);

    // Sized for the larger of the two UBOs (RaymarchUBO, 256 bytes) --
    // AxialSliceUBO (48 bytes) is written into the same buffer's leading
    // bytes when the axial-slice pipeline is active. See
    // createRenderPipelineFor()'s header comment for why WebGPU accepts
    // one buffer/bind group across both pipelines.
    WGPUBufferDescriptor uboDesc{};
    uboDesc.size = sizeof(RaymarchUBO);
    uboDesc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    uboBuffer_ = wgpuDeviceCreateBuffer(device_, &uboDesc);
}

// One-time setup for the accumulation-blit pass (§6.5) -- a 2-entry bind
// group layout (texture + sampler) distinct from bindGroupLayout_/
// pipelineLayout_ above, since this shader has entirely different
// resources, not another consumer of the raymarch/axial-slice layout.
// Blend is left at its WebGPU default (no blending -- a plain overwrite)
// since accumulationTexture_ always holds a fully-resolved, opaque frame
// by the time this pass reads it.
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
    // canonical LPS convention issue #21 established upstream (X=Left,
    // Y=Posterior, Z=Superior) -- see this method's header comment.
    glm::vec3 const halfExtent{
        static_cast<float>(width) * spacingX * 0.5F,
        static_cast<float>(height) * spacingY * 0.5F,
        static_cast<float>(depth) * spacingZ * 0.5F,
    };
    aabbMin_ = -halfExtent;
    aabbMax_ = halfExtent;
    finestSpacing_ = std::min({spacingX, spacingY, spacingZ});
    // Reset the clip box (§6.4) to the full volume -- a clip region sized
    // for a previously loaded (differently sized) volume would otherwise
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
    // the raymarch pass's own weight on its first/dirty frame (§6.5).
    WGPUColor const kOpaqueBlendConstant{1.0, 1.0, 1.0, 1.0};

    // How many of timestampQuerySet_'s 4 slots this frame's branch below
    // actually writes -- 0 (no-volume branch, unsupported, or a readback
    // already in flight), 2 (AxialSlice2D), or 4 (Orbit3D: raymarch +
    // composite). Read after the if/else chain to decide whether/how much
    // to resolve and read back.
    //
    // Gated on !timestampReadbackPending_, not just timestampQuerySupported_
    // -- confirmed via a real Dawn validation warning ("[Buffer (unlabeled)]
    // used in submit while mapped"/"while pending map"), not assumed: this
    // frame's resolveQuerySet()+copyBufferToBuffer() write into
    // timestampReadbackBuffer_, the exact same buffer a previous frame's
    // still-in-flight wgpuBufferMapAsync() has pending/mapped. WebGPU
    // forbids using a buffer in a submitted command while its map request is
    // pending or fulfilled. GPU readback latency is typically several
    // frames at this frame rate, so without this guard nearly every
    // submission hit the warning -- Dawn's response to it (dropping or
    // otherwise mishandling that submission) was the actual cause of the
    // rapid rendering flicker this fixes.
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

    if (hasVolume_ && pipeline_ && bindGroup_ && viewMode_ == kViewModeAxialSlice2D && axialPipeline_) {
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

        // "Contain" letterbox fit (issue #40 follow-up) -- see
        // axial_slice.slang's fitParams comment. aabbMax_-aabbMin_'s X/Y
        // already encode the volume's physical (spacing-aware) extent
        // (frameCameraForVolume()), so no separate spacing storage is
        // needed here.
        glm::vec3 const physicalExtent = aabbMax_ - aabbMin_;
        float const volumeAspect = physicalExtent.x / physicalExtent.y;
        float const canvasAspect = static_cast<float>(canvasWidth_) / static_cast<float>(canvasHeight_);
        float const fitScaleX = std::max(1.0F, canvasAspect / volumeAspect);
        float const fitScaleY = std::max(1.0F, volumeAspect / canvasAspect);

        AxialSliceUBO ubo{};
        ubo.sliceParams = glm::vec4{static_cast<float>(axialSliceIndex_), windowCenter_, windowWidth_, 0.0F};
        ubo.maskParams = glm::vec4{maskOverlayEnabled_ ? 1.0F : 0.0F, maskOverlayAlpha_, 0.0F, 0.0F};
        ubo.fitParams = glm::vec4{fitScaleX, fitScaleY, 0.0F, 0.0F};

        wgpuQueueWriteBuffer(queue_, uboBuffer_, 0, &ubo, sizeof(ubo));

        wgpuRenderPassEncoderSetPipeline(pass, axialPipeline_);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup_, 0, nullptr);
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

        // §6.5: dirty (accumFrameIndex_==0) means this frame fully
        // overwrites accumulationTexture_ (Clear + weight 1.0); otherwise
        // it blends in with weight 1/(n+1), a running average across
        // static frames.
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
        // No volume loaded yet (or pipelines not ready): a plain clear,
        // matching the pre-§6.5 no-volume behavior exactly.
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
    // emscripten_set_main_loop (CLAUDE.md #9).
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

    // Mobile OOM mitigation, on top of Option A's gradient-texture skip:
    // downsampleFactor_ > 1 also shrinks the volume texture itself
    // in-plane (X/Y only -- see downsampleNearestXY's own comment for why
    // depth is untouched and nearest-neighbor is used instead of
    // averaging). uint16_t const* reinterpret is safe here: data is
    // already validated above to be exactly width*height*depth*
    // sizeof(uint16_t) bytes, the same buffer layout downsampleNearestXY
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

    // Precomputed gradient volume (issue #81's own follow-up) -- same
    // voxel dimensions as volumeTexture_, baked by bakeGradientVolume()
    // below once volumeTextureView_ exists. StorageBinding for the
    // compute pass's write-only access, TextureBinding for the raymarch
    // fragment shader's later trilinear read.
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
    // Reports the *actual* chosen extent (gradientDesc.size), not just an
    // echo of the downsampleFactor input -- a test asserting on this line
    // catches a regression where the branch above silently stops honoring
    // the flag (e.g. always allocating full-size), which a pixel-only
    // comparison of the two modes' rendered output would not.
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

    // Bakes gradientTexture_ from the just-written volumeTexture_ (issue
    // #81's own follow-up) -- must run after both texture views above
    // exist, before rebuildBindGroup() references gradientTextureView_.
    // Skipped in low-memory mode: gradientTexture_ is a 1x1x1 placeholder
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
    // Defaults the AxialSlice2D view to the volume's middle slice (issue
    // #37) -- mirrors frameCameraForVolume()'s own reset-defaults-on-load
    // pattern for the Orbit3D camera below.
    axialSliceIndex_ = depth > 0 ? depth / 2 : 0;

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
    writeLutPreset(presetId);
    writePreintegratedLut(presetId);
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
    // own contribution), matching Mini-Engine-reference's Camera::zoom()
    // -- but with a floor relative to this volume's own size rather than
    // their fixed absolute 1.5, since world units here are physical mm
    // and vary per volume.
    float const zoomSpeed = std::max(extent * 0.05F, cameraDistance_ * 0.08F);
    cameraDistance_ -= wheelDeltaSign * zoomSpeed;
    cameraDistance_ = std::clamp(cameraDistance_, extent * 0.3F, extent * 10.0F);

    updateCameraMatrices();
    markAccumulationDirty();
}

void WebGPUDevice::setViewMode(uint32_t mode) {
    if (mode != kViewModeOrbit3D && mode != kViewModeAxialSlice2D) {
        std::printf("WebGPUDevice::setViewMode: invalid mode=%u, ignoring\n", mode);
        return;
    }
    viewMode_ = mode;
    markAccumulationDirty();
}

void WebGPUDevice::setAxialSliceIndex(uint32_t index) {
    if (!hasVolume_) {
        std::printf("WebGPUDevice::setAxialSliceIndex: no volume loaded, ignoring\n");
        return;
    }
    axialSliceIndex_ = std::min(index, volumeDepth_ - 1);
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

    // wgpuBufferGetMappedRange() (mutable) is write-mode only -- Dawn's own
    // emdawnwebgpu shim (webgpu.cpp, WGPUBufferImpl::GetMappedRange) asserts
    // `mPendingMapRequest.mode == WGPUMapMode_Write` and returns nullptr
    // otherwise; confirmed by reading that source directly after hitting the
    // assertion, not assumed. This buffer is mapped WGPUMapMode_Read, so the
    // const-returning accessor is the correct one for a read-only mapping.
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
