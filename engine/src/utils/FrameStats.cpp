#include "utils/FrameStats.hpp"

#include <algorithm>
#include <numeric>

namespace omnimed3d::utils {

void FrameStats::recordFrame() {
    const auto now = std::chrono::steady_clock::now();

    if (hasLastTimestamp_) {
        const std::chrono::duration<float, std::milli> delta = now - lastTimestamp_;
        lastFrameTimeMs_ = delta.count();

        samples_[writeIndex_] = lastFrameTimeMs_;
        writeIndex_ = (writeIndex_ + 1) % kSampleCount;
        sampleCount_ = std::min(sampleCount_ + 1, kSampleCount);
    }

    lastTimestamp_ = now;
    hasLastTimestamp_ = true;
}

float FrameStats::avgFrameTimeMs() const {
    if (sampleCount_ == 0) {
        return 0.0F;
    }
    const float sum = std::accumulate(samples_.begin(), samples_.begin() + static_cast<long>(sampleCount_), 0.0F);
    return sum / static_cast<float>(sampleCount_);
}

float FrameStats::fps() const {
    const float avg = avgFrameTimeMs();
    return avg > 0.0F ? 1000.0F / avg : 0.0F;
}

}  // namespace omnimed3d::utils
