#pragma once

#include <array>
#include <chrono>
#include <cstddef>

namespace omnimed3d::utils {

// Backend-agnostic CPU frame timer -- std::chrono::steady_clock works
// identically native and WASM, so unlike GpuProfiler-style GPU timestamp
// queries (deferred, see the debug-overlay plan), this needs no
// EMSCRIPTEN ifdef and no RHI dependency at all.
class FrameStats {
public:
    // Call once per renderFrame(), before any other FrameStats method is
    // read for that frame. The first call after construction only seeds
    // lastTimestamp_ (no prior frame to measure against), so
    // lastFrameTimeMs()/avgFrameTimeMs()/fps() stay at their zero defaults
    // until the second call.
    void recordFrame();

    float lastFrameTimeMs() const { return lastFrameTimeMs_; }
    float avgFrameTimeMs() const;
    float fps() const;

private:
    static constexpr size_t kSampleCount = 60;

    std::chrono::steady_clock::time_point lastTimestamp_{};
    bool hasLastTimestamp_ = false;

    std::array<float, kSampleCount> samples_{};
    size_t sampleCount_ = 0;   // number of valid entries in samples_ (caps at kSampleCount)
    size_t writeIndex_ = 0;    // next slot to overwrite (circular buffer)

    float lastFrameTimeMs_ = 0.0F;
};

}  // namespace omnimed3d::utils
