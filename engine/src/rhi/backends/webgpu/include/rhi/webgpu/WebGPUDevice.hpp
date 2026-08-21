#pragma once

#include "rhi/Device.hpp"

#include "core/RenderGraph.hpp"
#include "utils/FrameStats.hpp"

#include <glm/glm.hpp>
#include <webgpu/webgpu.h>

namespace omnimed3d::rhi::webgpu {

// Plain 8-bit RGB color -- shared between the compile-time colormap
// preset table (WebGPUDevice.cpp's anonymous namespace) and the
// writeLutColors()/writePreintegratedLutColors() helpers declared below,
// which both the fixed presets and setCustomColormap() (§5.3) funnel
// through.
struct ColorRGB {
    uint8_t r;
    uint8_t g;
    uint8_t b;
};

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
    void setQualityTier(uint32_t tier) override;
    void setShadingEnabled(bool enabled) override;
    void setExtinction(float extinction) override;
    void setDensityScale(float scale) override;
    void setThreshold(float threshold) override;
    void setClipBox(float minX, float minY, float minZ, float maxX, float maxY, float maxZ) override;
    void setGradientOpacityStrength(float strength) override;
    void setOcclusionEnabled(bool enabled) override;
    void setCustomColormap(float lowR, float lowG, float lowB, float highR, float highG, float highB) override;
    void resize(uint32_t width, uint32_t height) override;

    FrameStatsSnapshot getFrameStats() const override;
    HardwareInfo getHardwareInfo() const override;

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
    // One-time creation of the accumulation-blit pipeline/layout/shader
    // (§6.5) -- called once from createPipeline(), analogous to the
    // raymarch/axial pipelines it builds alongside.
    void createCompositePipeline();
    // (Re)creates accumulationTexture_/View sized to canvasWidth_/
    // canvasHeight_, and the compositeBindGroup_ that references it --
    // called once when the device becomes ready and again from resize()
    // whenever the canvas size actually changes (a fixed-size texture
    // can't just be reused at a new size). Releases the previous
    // texture/view/bind group first if this isn't the first call.
    void createAccumulationResources();
    // Writes one colormap preset's color ramp into lutTexture_ -- see the
    // .cpp definition's header comment.
    void writeLutPreset(uint32_t presetId);
    // Bakes one colormap preset's pre-integrated (front,back) table into
    // preintegratedLutTexture_ -- see the .cpp definition's header comment.
    void writePreintegratedLut(uint32_t presetId);
    // Shared low/high-color LUT writers underlying both writeLutPreset()
    // and setCustomColormap() (§5.3's Custom preset) -- see the .cpp
    // definitions' header comments.
    void writeLutColors(ColorRGB lowColor, ColorRGB highColor);
    void writePreintegratedLutColors(ColorRGB lowColor, ColorRGB highColor);
    void rebuildBindGroup();

    // Factors out the blend-state/color-target/pipeline-descriptor
    // boilerplate shared by both render pipelines (issue #37) -- the only
    // difference between the raymarch and axial-slice pipelines is which
    // shader module they run and which color target format they're built
    // against; bindGroupLayout_/pipelineLayout_ are built once by
    // createPipeline() and passed in unchanged. Both shaders declare the
    // exact same 6-entry bind group layout (uniform buffer, volume tex,
    // sampler, mask tex, LUT tex, pre-integrated LUT tex), so one
    // WGPUBindGroup (bindGroup_, referencing uboBuffer_ sized for the
    // larger RaymarchUBO) is valid for whichever pipeline is bound --
    // WebGPU validates the bound buffer range against each shader's own
    // reflected minimum size, and RaymarchUBO's 256 bytes comfortably
    // covers AxialSliceUBO's 48. colorTargetFormat must match whatever
    // render pass attachment the resulting pipeline is later used with --
    // WebGPU bakes a pipeline's color target format at creation time and
    // validates it against the actual attachment at draw time (§6.5: the
    // raymarch pipeline now targets accumulationTexture_'s RGBA16Float,
    // not the swapchain's BGRA8Unorm the axial-slice pipeline still uses;
    // passing the wrong format here produces an invalid pipeline that
    // silently no-ops every draw using it -- confirmed by hitting exactly
    // this while first wiring the accumulation buffer up).
    WGPURenderPipeline createRenderPipelineFor(WGPUShaderModule module, WGPUTextureFormat colorTargetFormat);

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

    // Resets accumFrameIndex_ to 0 -- called from every setter that
    // changes what renderFrame() draws (window/level, colormap preset,
    // quality tier, shading toggle, camera orbit/zoom, resize). Without
    // this, the temporal-accumulation blend in renderFrame() would mix
    // stale pre-change pixels with new ones (visible ghosting). Any
    // future image-affecting setter must call this too.
    void markAccumulationDirty();

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
    // Pre-integrated (front,back) transfer-function table (§6.1) -- only
    // the raymarch pipeline samples this; see preintegratedLutTex's
    // comment in volume_raymarch.slang.
    WGPUTexture preintegratedLutTexture_ = nullptr;
    WGPUTextureView preintegratedLutTextureView_ = nullptr;
    // Rebuilt in rebuildBindGroup() -- depends on volumeTextureView_/
    // maskTextureView_, which change every loadVolume() call.
    WGPUBindGroup bindGroup_ = nullptr;

    // Axial-slice pipeline (issue #37, PRD §9 slice-panning gap) -- shares
    // bindGroupLayout_/pipelineLayout_/uboBuffer_/bindGroup_ with the
    // raymarch pipeline above; only the shader module and pipeline object
    // differ. See createRenderPipelineFor()'s header comment.
    WGPUShaderModule axialShaderModule_ = nullptr;
    WGPURenderPipeline axialPipeline_ = nullptr;

    // Jitter + temporal accumulation (§6.5) -- the raymarch pass renders
    // into this persistent offscreen buffer instead of the swapchain
    // directly, blending each new (jittered) frame in with weight
    // 1/(accumFrameIndex_+1) while the camera/params are static
    // (markAccumulationDirty() resets the blend to a full overwrite). A
    // separate composite pass then blits it to the swapchain. This
    // indirection exists because wgpuSurfaceGetCurrentTexture() returns a
    // *different physical texture* every frame (the swapchain is
    // double/triple-buffered) -- blending directly against "whatever's in
    // this frame's swapchain buffer" would accumulate against stale,
    // 2-3-frames-old content instead of the true previous frame, causing
    // visible flicker rather than convergence. RGBA16Float (not 8Unorm)
    // so repeated low-weight blends don't visibly quantize/band before
    // convergence. Sized to canvasWidth_/canvasHeight_, (re)created by
    // createAccumulationResources().
    WGPUTexture accumulationTexture_ = nullptr;
    WGPUTextureView accumulationTextureView_ = nullptr;

    // Composite/blit pipeline (§6.5) -- reads accumulationTexture_ and
    // writes it to the swapchain, unchanged. A distinct 2-entry bind
    // group layout (texture + sampler only) from bindGroupLayout_ above,
    // since it's a genuinely different shader with different resources,
    // not another consumer of the raymarch/axial-slice layout.
    WGPUShaderModule compositeShaderModule_ = nullptr;
    WGPUBindGroupLayout compositeBindGroupLayout_ = nullptr;
    WGPUPipelineLayout compositePipelineLayout_ = nullptr;
    WGPURenderPipeline compositePipeline_ = nullptr;
    // Rebuilt in createAccumulationResources() -- depends on
    // accumulationTextureView_, which is recreated on every resize().
    WGPUBindGroup compositeBindGroup_ = nullptr;

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
    // Smallest of spacingX/Y/Z from the most recent loadVolume() call, in
    // world mm -- used to keep the raymarch step size from undersampling
    // the volume's finest axis on anisotropic data (thick-slice CT/MR).
    // 0 until a volume has been loaded.
    float finestSpacing_ = 0.0F;

    // Window/level + mask overlay parameters -- defaults applied in
    // createPipeline(); overridden via setWindowLevel()/setColormapPreset()
    // or once real data has been observed to have a class present.
    float windowCenter_ = 0.0F;
    float windowWidth_ = 400.0F;
    bool maskOverlayEnabled_ = true;

    // REQ-R04 quality/step-count tier -- see kQualityTiers in
    // WebGPUDevice.cpp. Default matches the previous hardcoded behavior
    // (Medium == the old fixed 512-step/diagonal-384 formula).
    uint32_t qualityTier_ = 1;
    // Gradient-based Lambert shading toggle -- see setShadingEnabled().
    bool shadingEnabled_ = true;
    // Temporal-accumulation frame counter (jitter + accumulate while the
    // camera/params are static) -- reset to 0 by markAccumulationDirty(),
    // incremented once per renderFrame() call otherwise.
    float accumFrameIndex_ = 0.0F;

    // TF detail controls (§5.3) -- were fixed constants before these
    // setters existed (extinction) or simply didn't exist (the rest).
    // Defaults exactly reproduce Branch 1's behavior for anyone who never
    // touches these new controls.
    float extinction_ = 8.0F;
    float densityScale_ = 1.0F;
    float threshold_ = 0.0F;
    float gradientOpacityStrength_ = 0.0F;
    bool occlusionEnabled_ = false;

    // Clipping box (§6.4), world mm -- reset to the full aabbMin_/aabbMax_
    // on every loadVolume() (frameCameraForVolume()), since a clip region
    // sized for a previous volume would otherwise misclip a newly loaded
    // one of different physical size.
    glm::vec3 clipMin_{0.0F};
    glm::vec3 clipMax_{0.0F};

    // Custom colormap (§5.3's 5th preset) -- applied via setCustomColormap(),
    // independent of kColormapPresets/setColormapPreset(). Defaults are
    // arbitrary (never rendered with until setCustomColormap() is called
    // at least once).
    ColorRGB customLowColor_{0, 0, 0};
    ColorRGB customHighColor_{255, 255, 255};

    // Debug/perf overlay state (see getFrameStats()/getHardwareInfo()).
    // frameStats_ is recorded once per renderFrame(); hardwareInfo_ is
    // populated once in onDeviceRequested(), when adapter_ first becomes
    // valid, and never changes after that.
    utils::FrameStats frameStats_;
    HardwareInfo hardwareInfo_;
};

}  // namespace omnimed3d::rhi::webgpu
