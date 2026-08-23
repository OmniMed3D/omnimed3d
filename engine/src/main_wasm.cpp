// WASM smoke-test entry point (roadmap step 2: minimal WebGPU canvas).
// Not the real application entry point -- viewer/ wraps the WASM module
// for that (roadmap step 6). This exists to visually prove the WebGPU
// pipeline works end-to-end in Chrome.

#include "rhi/webgpu/WebGPUDevice.hpp"

#include <emscripten/emscripten.h>

#include <string>

namespace {
omnimed3d::rhi::webgpu::WebGPUDevice g_device;

void tick() {
    g_device.renderFrame();
}
}  // namespace

int main() {
    g_device.initialize();
    // fps=0 lets the browser drive the rate via requestAnimationFrame;
    // simulate_infinite_loop=true keeps main() from returning, which
    // Emscripten's runtime expects when using this callback style.
    emscripten_set_main_loop(tick, 0, true);
    return 0;
}

// JS-callable exports (roadmap step 4). EMSCRIPTEN_KEEPALIVE alone makes
// these callable as Module._engine_load_volume(...) / Module._engine_apply_mask_slice(...)
// -- no additional -s EXPORTED_FUNCTIONS linker flag needed (main() itself
// is already proof this mechanism works). Real orchestration (minting
// volumeId, receiving Parse/Inference Worker output) is the future
// viewer/-owned layer, PRD #5.3.2 -- this smoke test's shell.html simulates
// it with synthetic data.
extern "C" {

EMSCRIPTEN_KEEPALIVE
int engine_is_ready() {
    return g_device.isReady() ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void engine_load_volume(uint32_t volumeId, uint8_t* data, size_t byteLength, uint32_t width,
                         uint32_t height, uint32_t depth, float spacingX, float spacingY, float spacingZ) {
    g_device.loadVolume(volumeId, data, byteLength, width, height, depth, spacingX, spacingY, spacingZ);
}

EMSCRIPTEN_KEEPALIVE
void engine_apply_mask_slice(uint32_t volumeId, uint32_t sliceIndex, uint32_t width, uint32_t height,
                              uint8_t* data, size_t byteLength) {
    g_device.applyMaskSlice(volumeId, sliceIndex, width, height, data, byteLength);
}

// Issue #29 (REQ-R02/R03): clinical window/level, set directly or via a
// baseline preset. Both safe to call whether or not a volume is loaded yet
// -- see rhi::Device::setWindowLevel's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_window_level(float center, float width) {
    g_device.setWindowLevel(center, width);
}

// presetId: 0=Lung, 1=Bone, 2=Soft Tissue, 3=Brain, 4=Grayscale (default)
// -- see kColormapPresets in WebGPUDevice.cpp for the concrete values.
EMSCRIPTEN_KEEPALIVE
void engine_set_colormap_preset(uint32_t presetId) {
    g_device.setColormapPreset(presetId);
}

// Issue #34 (REQ-R06): interactive orbit camera. dx/dy are raw mouse-drag
// pixel deltas -- see rhi::Device::orbitCamera's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_orbit_camera(float deltaYawPixels, float deltaPitchPixels) {
    g_device.orbitCamera(deltaYawPixels, deltaPitchPixels);
}

// wheelDeltaSign: caller pre-normalizes to +-1 per wheel notch -- see
// rhi::Device::zoomCamera's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_zoom_camera(float wheelDeltaSign) {
    g_device.zoomCamera(wheelDeltaSign);
}

// Issue #37 (PRD §9 slice-panning gap): view-mode toggle. mode: 0=Orbit3D,
// 1=AxialSlice2D -- see rhi::Device::setViewMode's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_view_mode(uint32_t mode) {
    g_device.setViewMode(mode);
}

// Raw voxel Z index (not normalized) for the AxialSlice2D view -- see
// rhi::Device::setAxialSliceIndex's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_axial_slice_index(uint32_t index) {
    g_device.setAxialSliceIndex(index);
}

// Issue #40: canvas backing-store pixel dimensions (post-devicePixelRatio
// scaling, not CSS pixels) -- see rhi::Device::resize's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_resize(uint32_t width, uint32_t height) {
    g_device.resize(width, height);
}

// REQ-R04: raymarch quality/step-count tier. tier: 0=Low, 1=Medium
// (default), 2=High -- see rhi::Device::setQualityTier's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_quality_tier(uint32_t tier) {
    g_device.setQualityTier(tier);
}

// Gradient-based Lambert shading mode: 0=off, 1=on, 2=on-flat -- see
// rhi::Device::setShadingMode's header comment. Export name kept as
// `_enabled` (not renamed to `_mode`) even though it now accepts a
// tri-state value, to avoid an unrelated JS-side rename churning every
// call site for what's still fundamentally the same control.
EMSCRIPTEN_KEEPALIVE
void engine_set_shading_enabled(uint32_t mode) {
    g_device.setShadingMode(mode);
}

// TF detail controls -- see rhi::Device::setExtinction/setDensityScale/
// setThreshold's header comments.
EMSCRIPTEN_KEEPALIVE
void engine_set_extinction(float extinction) {
    g_device.setExtinction(extinction);
}

EMSCRIPTEN_KEEPALIVE
void engine_set_density_scale(float scale) {
    g_device.setDensityScale(scale);
}

EMSCRIPTEN_KEEPALIVE
void engine_set_threshold(float threshold) {
    g_device.setThreshold(threshold);
}

// Clip box (world mm) -- see rhi::Device::setClipBox's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_clip_box(float minX, float minY, float minZ, float maxX, float maxY, float maxZ) {
    g_device.setClipBox(minX, minY, minZ, maxX, maxY, maxZ);
}

// See rhi::Device::setGradientOpacityStrength's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_gradient_opacity_strength(float strength) {
    g_device.setGradientOpacityStrength(strength);
}

// Directional Occlusion Shading toggle -- see
// rhi::Device::setOcclusionEnabled's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_occlusion_enabled(uint32_t enabled) {
    g_device.setOcclusionEnabled(enabled != 0);
}

// Custom colormap (on top of the 5 fixed presets above) -- low/high RGB
// in [0,1]. See rhi::Device::setCustomColormap's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_custom_lut_colors(float lowR, float lowG, float lowB, float highR, float highG, float highB) {
    g_device.setCustomColormap(lowR, lowG, lowB, highR, highG, highB);
}

// AI segmentation mask overlay blend strength -- see
// rhi::Device::setMaskOverlayAlpha's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_mask_opacity(float alpha) {
    g_device.setMaskOverlayAlpha(alpha);
}

// See rhi::Device::setBackgroundColor's header comment.
EMSCRIPTEN_KEEPALIVE
void engine_set_background_color(float r, float g, float b) {
    g_device.setBackgroundColor(r, g, b);
}

// Debug/perf overlay (baseline browser-performance measurement --
// engine/tests/wasm_smoke/shell.html's stats panel). See
// rhi::Device::getFrameStats/getHardwareInfo's header comments.
EMSCRIPTEN_KEEPALIVE
float engine_get_frame_time_ms() {
    return g_device.getFrameStats().frameTimeMs;
}

EMSCRIPTEN_KEEPALIVE
float engine_get_avg_frame_time_ms() {
    return g_device.getFrameStats().avgFrameTimeMs;
}

EMSCRIPTEN_KEEPALIVE
float engine_get_fps() {
    return g_device.getFrameStats().fps;
}

// String getters cache into a function-local static std::string, reassigned
// on every call -- safe under Emscripten's single-threaded model, and gives
// the returned char* a lifetime that outlives the call for
// Module.UTF8ToString() on the JS side.
EMSCRIPTEN_KEEPALIVE
const char* engine_get_gpu_vendor() {
    static std::string s;
    s = g_device.getHardwareInfo().vendor;
    return s.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_gpu_architecture() {
    static std::string s;
    s = g_device.getHardwareInfo().architecture;
    return s.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_gpu_device() {
    static std::string s;
    s = g_device.getHardwareInfo().device;
    return s.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_gpu_description() {
    static std::string s;
    s = g_device.getHardwareInfo().description;
    return s.c_str();
}

// GPU-side per-pass timing (WebGPU timestamp-query, optional feature). See
// rhi::Device::getGpuTiming's header comment -- check
// engine_get_gpu_timing_supported() before trusting the *_ms getters.
EMSCRIPTEN_KEEPALIVE
uint32_t engine_get_gpu_timing_supported() {
    return g_device.getGpuTiming().supported ? 1U : 0U;
}

EMSCRIPTEN_KEEPALIVE
float engine_get_gpu_raymarch_ms() {
    return g_device.getGpuTiming().raymarchMs;
}

EMSCRIPTEN_KEEPALIVE
float engine_get_gpu_composite_ms() {
    return g_device.getGpuTiming().compositeMs;
}

EMSCRIPTEN_KEEPALIVE
float engine_get_gpu_axial_ms() {
    return g_device.getGpuTiming().axialMs;
}

}  // extern "C"
