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
                     float spacingX, float spacingY, float spacingZ, uint32_t downsampleFactor) override;
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
    void setShadingMode(uint32_t mode) override;
    void setExtinction(float extinction) override;
    void setDensityScale(float scale) override;
    void setThreshold(float threshold) override;
    // Not part of the rhi::Device interface (yet) -- a debug/tuning knob
    // for the upper half of the threshold band (§5.3 follow-up,
    // 2026-08-27), set today only via setColormapPreset()'s per-preset
    // defaults. Promote to the interface (+ a WASM export + a UI slider)
    // if this ever needs to be user-adjustable rather than preset-only.
    void setThresholdMax(float thresholdMax);
    void setClipBox(float minX, float minY, float minZ, float maxX, float maxY, float maxZ) override;
    void setGradientOpacityStrength(float strength) override;
    void setOcclusionEnabled(bool enabled) override;
    void setMaskOverlayAlpha(float alpha) override;
    void setMaskOverlayEnabled(bool enabled) override;
    void setCustomColormap(float lowR, float lowG, float lowB, float highR, float highG, float highB) override;
    void setBackgroundColor(float r, float g, float b) override;
    void resize(uint32_t width, uint32_t height) override;
    void setRenderPaused(bool paused) override;

    FrameStatsSnapshot getFrameStats() const override;
    HardwareInfo getHardwareInfo() const override;
    GpuTimingSnapshot getGpuTiming() const override;
    DeviceLossSnapshot getDeviceLossState() const override;
    void clearUncapturedError() override;

    // Not part of the rhi::Device interface -- exposing a live GPUDevice
    // handle to JS purely to call the real device.destroy() from a test
    // would mean reaching into Emscripten's internal WebGPU handle table
    // (WebGPU.mgrDevice), which is undocumented/version-fragile. Instead,
    // an e2e test can trigger the exact same onDeviceLost() code path a
    // real Dawn-fired callback would (same reason/message plumbing,
    // same renderFrame() guard, same getDeviceLossState() result) --
    // WASM-debug-only, not part of the abstract Device interface since a
    // future native Vulkan backend has no equivalent notion of this.
    void debugSimulateDeviceLost();

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

    // Mobile OOM mitigation -- registered on deviceDesc in
    // onAdapterRequested(), fired by Dawn itself (not something this
    // engine calls). Signatures match WGPUDeviceLostCallback/
    // WGPUUncapturedErrorCallback in the emdawnwebgpu port's webgpu.h
    // exactly, same "confirmed by reading the actual header" standard as
    // onAdapterRequested/onDeviceRequested above.
    static void onDeviceLost(WGPUDevice const* device, WGPUDeviceLostReason reason, WGPUStringView message,
                              void* userdata1, void* userdata2);
    static void onUncapturedError(WGPUDevice const* device, WGPUErrorType type, WGPUStringView message,
                                   void* userdata1, void* userdata2);

    // GPU-side per-pass timing (WebGPU `timestamp-query`, optional feature
    // -- see rhi::Device::getGpuTiming's header comment). Query set has 4
    // slots: [0,1] = begin/end of whichever single-pass-per-frame branch
    // ran (raymarch accumulation pass in Orbit3D mode, or the axial-slice
    // pass in AxialSlice2D mode -- only one of the two ever runs in a given
    // frame), [2,3] = begin/end of the composite pass (Orbit3D only, runs
    // right after the raymarch pass). Reused every frame rather than
    // multiplexed across frames-in-flight -- this engine has no other
    // frames-in-flight concept to hook into, and a single pending-readback
    // guard (timestampReadbackPending_) is enough to avoid mapping a buffer
    // that's already being mapped.
    void createTimestampQuery();
    // Maps timestampReadbackBuffer_ async and reads it back in
    // onTimestampBufferMapped() -- no-ops if a previous readback is still
    // pending (keeps last frame's numbers displayed rather than queuing up
    // maps). Called from renderFrame() after submitting a frame that wrote
    // timestamps; queryCount is how many of the 4 slots that frame actually
    // wrote (2 for AxialSlice2D, 4 for Orbit3D).
    void beginTimestampReadback(uint32_t queryCount);
    static void onTimestampBufferMapped(WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1,
                                         void* userdata2);

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
    // Writes a color ramp into lutTexture_, and bakes the matching
    // pre-integrated (front,back) table into preintegratedLutTexture_ --
    // shared by setColormapPreset() (every fixed preset writes the same
    // plain grayscale pair, see ColormapPreset's own comment) and
    // setCustomColormap() (§5.3's Custom preset) -- see the .cpp
    // definitions' header comments.
    void writeLutColors(ColorRGB lowColor, ColorRGB highColor);
    void writePreintegratedLutColors(ColorRGB lowColor, ColorRGB highColor);
    void rebuildBindGroup();

    // Releases volumeTexture_/maskTexture_/gradientTexture_ and their views
    // (all null-guarded) -- loadVolume() calls this to replace a
    // previously-loaded volume's resources before creating new ones.
    void releaseVolumeResources();

    // One-time creation of the gradient-bake compute pipeline (issue #81's
    // own follow-up) -- called once from createPipeline(), analogous to
    // createCompositePipeline(). Its own 3-entry bind group layout (HU
    // volume read, gradient volume storage-write, a small spacing uniform)
    // is unrelated to bindGroupLayout_/pipelineLayout_ above -- a genuinely
    // different (compute, not render) pipeline with different resources.
    void createGradientBakePipeline();
    // Dispatches the gradient-bake compute pass over the just-loaded
    // volume's full extent -- called once from loadVolume(), after
    // volumeTexture_/gradientTexture_ both exist. One-shot: builds its own
    // bind group referencing this call's specific texture views rather
    // than keeping one around, since it only ever runs right after a new
    // volume load.
    void bakeGradientVolume(uint32_t width, uint32_t height, uint32_t depth,
                             float spacingX, float spacingY, float spacingZ);

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

    // Mobile OOM mitigation (see rhi::Device::getDeviceLossState's header
    // comment) -- deviceLost_ is checked in renderFrame()'s top guard
    // alongside ready_, since device_/queue_ are stale handles once it's
    // true. Set only by onDeviceLost()/onUncapturedError(), which Dawn
    // itself fires (WGPUCallbackMode_AllowSpontaneous), not something
    // this class calls directly.
    bool deviceLost_ = false;
    DeviceLossReason deviceLossReason_ = DeviceLossReason::None;
    std::string deviceLossMessage_;
    bool hasUncapturedError_ = false;
    std::string uncapturedErrorMessage_;

    // Mobile OOM mitigation -- set via setRenderPaused(), checked in
    // renderFrame()'s top guard alongside ready_/deviceLost_. Frees the
    // GPU for concurrent AI inference during the paused window (Shell
    // pauses while the Inference Worker is actively running a batch).
    // Deliberately never touched by markAccumulationDirty() or any
    // setter that calls it -- pausing/resuming must not reset
    // accumFrameIndex_, or resuming would show a visible brightness
    // flash for no visual reason (see setRenderPaused()'s own comment).
    bool pauseRendering_ = false;

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
    // Precomputed gradient volume (issue #81's own follow-up,
    // gradient_bake.slang) -- same voxel dimensions as volumeTexture_,
    // (re)created and baked in loadVolume() every time a new volume loads.
    WGPUTexture gradientTexture_ = nullptr;
    WGPUTextureView gradientTextureView_ = nullptr;
    uint32_t currentVolumeId_ = 0;
    bool hasVolume_ = false;
    // The actual GPU texture's dimensions -- may be smaller than what
    // loadVolume() received if downsampleFactor_ downsampled it (see
    // originalVolumeWidth_/originalVolumeHeight_ below).
    uint32_t volumeWidth_ = 0;
    uint32_t volumeHeight_ = 0;
    uint32_t volumeDepth_ = 0;
    // What loadVolume() actually received (before any downsampleFactor_
    // downsampling) -- applyMaskSlice()'s incoming slices are always at
    // this resolution (the AI Worker runs against the original DICOM
    // series, unaware of the Engine's internal downsampling), so this is
    // what its width/height validation checks against, separately from
    // volumeWidth_/volumeHeight_ above. Equal to volumeWidth_/
    // volumeHeight_ whenever downsampleFactor_ is 1.
    uint32_t originalVolumeWidth_ = 0;
    uint32_t originalVolumeHeight_ = 0;
    // Set per loadVolume() call (mobile OOM mitigation) -- 1 means full
    // resolution; a value > 1 skips baking gradientTexture_ (a
    // full-volume RGBA16Float texture, 4x volumeTexture_'s own size) in
    // favor of an on-the-fly per-step gradient in the raymarch shader,
    // and downsamples the volume/mask textures in-plane by that factor.
    // See loadVolume()'s own comment.
    uint32_t downsampleFactor_ = 1;

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

    // Gradient-bake compute pipeline (issue #81's own follow-up) -- built
    // once by createGradientBakePipeline(). gradientBakeParamsBuffer_ holds
    // just the loaded volume's physical voxel spacing (a GradientBakeParams
    // uniform, gradient_bake.slang), rewritten by bakeGradientVolume() on
    // every loadVolume() call; the bind group referencing that call's
    // specific volumeTextureView_/gradientTextureView_ is built fresh each
    // time inside bakeGradientVolume() itself rather than kept as a member
    // (see bakeGradientVolume()'s own header comment for why).
    WGPUShaderModule gradientBakeShaderModule_ = nullptr;
    WGPUBindGroupLayout gradientBakeBindGroupLayout_ = nullptr;
    WGPUPipelineLayout gradientBakePipelineLayout_ = nullptr;
    WGPUComputePipeline gradientBakePipeline_ = nullptr;
    WGPUBuffer gradientBakeParamsBuffer_ = nullptr;

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
    // Mask highlight blend strength (§5.3.1) -- was a fixed 0.6 literal
    // written directly into both UBOs' maskParams.y before setMaskOverlayAlpha()
    // existed.
    float maskOverlayAlpha_ = 0.6F;

    // REQ-R04 quality/step-count tier -- see kQualityTiers in
    // WebGPUDevice.cpp. Default matches the previous hardcoded behavior
    // (Medium == the old fixed 512-step/diagonal-384 formula).
    uint32_t qualityTier_ = 1;
    // Gradient-based Lambert shading mode (0=off, 1=on, 2=on-flat) -- see
    // setShadingMode().
    uint32_t shadingMode_ = 1;
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
    // Upper cutoff paired with threshold_ (§5.3 follow-up, 2026-08-27) --
    // 1.0 means "no upper cutoff" (every preset except Lung leaves this
    // alone; see ColormapPreset::thresholdMax's own comment for why Lung
    // needs the opposite-direction cutoff threshold_ alone can't provide).
    // No public setter/WASM export -- set only by setColormapPreset(),
    // the same way windowCenter_/windowWidth_ are, not exposed as its own
    // slider.
    float thresholdMax_ = 1.0F;
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

    // Raymarch background color (setBackgroundColor()) -- composited by
    // volume_raymarch.slang's fragmentMain against whatever the ray didn't
    // hit, and mirrored into every render-pass clearValue in renderFrame()
    // (letterbox bars, the no-volume-loaded fallback, and the otherwise-
    // dead accumulation/composite-pass clears) so there's no visible seam
    // between "this shader's own compositing" and "a render pass's plain
    // clear color" cases. Default matches the previous hardcoded constant
    // (0.05, 0.05, 0.12) exactly, so nobody who never touches this control
    // sees any change.
    glm::vec3 backgroundColor_{0.05F, 0.05F, 0.12F};

    // Debug/perf overlay state (see getFrameStats()/getHardwareInfo()).
    // frameStats_ is recorded once per renderFrame(); hardwareInfo_ is
    // populated once in onDeviceRequested(), when adapter_ first becomes
    // valid, and never changes after that.
    utils::FrameStats frameStats_;
    HardwareInfo hardwareInfo_;

    // GPU pass timing (see getGpuTiming(), createTimestampQuery()'s header
    // comment). timestampQuerySupported_ is set in onAdapterRequested()
    // (before the device is even requested, since it gates whether
    // `timestamp-query` is included in requiredFeatures) and never changes
    // after. The query set/buffers are only created (createTimestampQuery())
    // when supported -- stay null otherwise, and renderFrame() skips writing
    // timestamps entirely in that case.
    bool timestampQuerySupported_ = false;
    static constexpr uint32_t kTimestampQueryCount = 4;
    WGPUQuerySet timestampQuerySet_ = nullptr;
    WGPUBuffer timestampResolveBuffer_ = nullptr;
    WGPUBuffer timestampReadbackBuffer_ = nullptr;
    // True from beginTimestampReadback() until onTimestampBufferMapped()
    // fires -- guards against mapping a buffer that's already being mapped
    // (WebGPU disallows overlapping maps of the same buffer).
    bool timestampReadbackPending_ = false;
    // How many of the 4 query slots the in-flight readback's frame actually
    // wrote (2 for AxialSlice2D, 4 for Orbit3D) -- captured at
    // beginTimestampReadback() time, since renderFrame() may have moved on
    // to a different view mode by the time onTimestampBufferMapped() fires.
    uint32_t pendingTimestampQueryCount_ = 0;
    float gpuRaymarchMs_ = 0.0F;
    float gpuCompositeMs_ = 0.0F;
    float gpuAxialMs_ = 0.0F;
};

}  // namespace omnimed3d::rhi::webgpu
