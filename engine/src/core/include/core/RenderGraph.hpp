#pragma once

#include <string>
#include <string_view>
#include <unordered_map>

namespace omnimed3d::core {

// Logical GPU resource states this engine currently distinguishes. Not
// exhaustive -- grow as real passes need finer-grained states (mirrors
// ADR-0001's "logical-resource-state -> barrier-value lookup table" idea,
// just without a real barrier-value side yet -- see RenderGraph below).
enum class ResourceState {
    Uninitialized,
    TransferDst,
    ShaderReadOnly,
    RenderTarget,
};

// Minimal seed of ADR-0001's render graph: "one render graph owns 100% of
// GPU resource-state transitions engine-wide, no exceptions." Today
// (WebGPU only) this is bookkeeping + invariant-checking, not real barrier
// emission -- WebGPU/Dawn infers its own transitions, so there is nothing
// to *emit* yet. What this still buys: a single place that knows every
// resource's current logical state, and catches nonsensical transitions
// (e.g. binding a texture for shader reads before anything ever wrote to
// it) via transitionValid() -- a real bug class, not just ADR-compliance
// bookkeeping. When a second (Vulkan) backend needs explicit barriers,
// the logical-state -> barrier-value lookup table plugs in here without
// touching call sites that already report through this class.
class RenderGraph {
public:
    void declareResource(std::string_view id, ResourceState initial);
    void transition(std::string_view id, ResourceState next);
    ResourceState currentState(std::string_view id) const;

    // Pure predicate behind transition()'s validity check -- exposed
    // separately so it's unit-testable without needing to inspect log
    // output (RenderGraphTest.cpp).
    static bool transitionValid(ResourceState from, ResourceState to);

private:
    std::unordered_map<std::string, ResourceState> states_;
};

}  // namespace omnimed3d::core
