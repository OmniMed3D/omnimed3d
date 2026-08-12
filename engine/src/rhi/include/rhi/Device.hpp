#pragma once

namespace omnimed3d::rhi {

// Minimal backend-agnostic seam -- intentionally not a full RHI yet (no
// Buffer/Texture/Pipeline/BindGroup). There is nothing to draw until
// roadmap step 4 (volume texture); designing those abstractions now would
// be guessing at shapes with only one backend and no real draw call to
// validate against. Grow this interface when a second backend or a real
// resource type actually needs it.
class Device {
public:
    virtual ~Device() = default;

    // Dispatches async adapter/device acquisition and returns immediately --
    // callers must poll isReady() before renderFrame(). Deliberately
    // non-blocking: a blocking wait here would need ASYNCIFY, which
    // CLAUDE.md #9 flags as a real trap to avoid where possible.
    virtual void initialize() = 0;

    virtual bool isReady() const = 0;

    // Clears and presents one frame. No-op if !isReady().
    virtual void renderFrame() = 0;
};

}  // namespace omnimed3d::rhi
