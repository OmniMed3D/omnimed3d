// WASM smoke-test entry point (roadmap step 2: minimal WebGPU canvas).
// Not the real application entry point -- viewer/ wraps the WASM module
// for that (roadmap step 6). This exists to visually prove the WebGPU
// pipeline works end-to-end in Chrome.

#include "rhi/webgpu/WebGPUDevice.hpp"

#include <emscripten/emscripten.h>

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

}  // extern "C"
