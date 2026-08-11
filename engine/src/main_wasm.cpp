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
