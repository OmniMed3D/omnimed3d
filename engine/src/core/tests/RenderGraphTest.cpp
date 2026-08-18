// Native-only automated regression test for core::RenderGraph -- hand-rolled
// assertions (no GoogleTest/Catch2 dependency, per CLAUDE.md #4's "no new
// dependencies without explicit consent") wired into CTest, same pattern as
// dicom-parser/tests/DicomFileTest.cpp.

#include "core/RenderGraph.hpp"

#include <cstdio>

namespace {

int g_failures = 0;

void check(bool condition, char const* description) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", description);
        ++g_failures;
    }
}

using omnimed3d::core::RenderGraph;
using omnimed3d::core::ResourceState;

void testDeclareAndQuery() {
    RenderGraph graph;
    graph.declareResource("volume", ResourceState::Uninitialized);
    check(graph.currentState("volume") == ResourceState::Uninitialized, "declared resource starts Uninitialized");
    check(graph.currentState("never-declared") == ResourceState::Uninitialized,
          "unknown resource id reads as Uninitialized rather than throwing");
}

void testValidTransitionSequence() {
    RenderGraph graph;
    graph.declareResource("volume", ResourceState::Uninitialized);

    graph.transition("volume", ResourceState::TransferDst);
    check(graph.currentState("volume") == ResourceState::TransferDst, "Uninitialized -> TransferDst applied");

    graph.transition("volume", ResourceState::ShaderReadOnly);
    check(graph.currentState("volume") == ResourceState::ShaderReadOnly,
          "TransferDst -> ShaderReadOnly applied (written before read)");

    graph.transition("volume", ResourceState::TransferDst);
    check(graph.currentState("volume") == ResourceState::TransferDst,
          "ShaderReadOnly -> TransferDst applied (reload after a previous render)");
}

void testTransitionValidPredicate() {
    check(RenderGraph::transitionValid(ResourceState::TransferDst, ResourceState::ShaderReadOnly),
          "TransferDst -> ShaderReadOnly is valid");
    check(RenderGraph::transitionValid(ResourceState::ShaderReadOnly, ResourceState::ShaderReadOnly),
          "ShaderReadOnly -> ShaderReadOnly is valid (re-bind across frames)");
    check(!RenderGraph::transitionValid(ResourceState::Uninitialized, ResourceState::ShaderReadOnly),
          "Uninitialized -> ShaderReadOnly is invalid -- the exact bug this class exists to catch "
          "(sampling a texture nothing ever wrote to)");
    check(RenderGraph::transitionValid(ResourceState::Uninitialized, ResourceState::TransferDst),
          "Uninitialized -> TransferDst is valid (first write)");
    check(RenderGraph::transitionValid(ResourceState::Uninitialized, ResourceState::RenderTarget),
          "Uninitialized -> RenderTarget is valid (swapchain view used directly, no write step)");
}

void testInvalidTransitionStillAppliesState() {
    // transition() logs on an invalid transition but still records the
    // requested state -- it's an invariant-violation report, not a hard
    // abort (this pass isn't mature enough to justify crashing on it yet).
    RenderGraph graph;
    graph.declareResource("mask", ResourceState::Uninitialized);
    graph.transition("mask", ResourceState::ShaderReadOnly);
    check(graph.currentState("mask") == ResourceState::ShaderReadOnly,
          "invalid transition still records the requested state (not silently dropped)");
}

}  // namespace

int main() {
    testDeclareAndQuery();
    testValidTransitionSequence();
    testTransitionValidPredicate();
    testInvalidTransitionStillAppliesState();

    if (g_failures == 0) {
        std::printf("All core tests passed.\n");
        return 0;
    }
    std::fprintf(stderr, "%d core test(s) failed.\n", g_failures);
    return 1;
}
