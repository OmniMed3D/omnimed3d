#include "core/RenderGraph.hpp"

#include <cstdio>

namespace omnimed3d::core {

void RenderGraph::declareResource(std::string_view id, ResourceState initial) {
    states_[std::string(id)] = initial;
}

bool RenderGraph::transitionValid(ResourceState from, ResourceState to) {
    switch (to) {
        case ResourceState::ShaderReadOnly:
            // The bug this whole class exists to catch: binding a resource
            // for shader reads before anything ever wrote to it.
            return from == ResourceState::TransferDst || from == ResourceState::ShaderReadOnly;
        case ResourceState::RenderTarget:
            return true;  // swapchain view: fine to (re)use directly every frame
        case ResourceState::TransferDst:
            return true;  // writing is always fine regardless of prior state
        case ResourceState::Uninitialized:
            return from == ResourceState::Uninitialized;  // no legitimate case reverts to this
    }
    return false;
}

void RenderGraph::transition(std::string_view id, ResourceState next) {
    std::string const key(id);
    ResourceState const from = states_.count(key) ? states_.at(key) : ResourceState::Uninitialized;

    if (!transitionValid(from, next)) {
        std::fprintf(stderr,
                      "RenderGraph: invalid transition for '%s' (state %d -> %d) -- resource used before it "
                      "was ever written\n",
                      key.c_str(), static_cast<int>(from), static_cast<int>(next));
    }

    states_[key] = next;
}

ResourceState RenderGraph::currentState(std::string_view id) const {
    std::string const key(id);
    auto const it = states_.find(key);
    return it == states_.end() ? ResourceState::Uninitialized : it->second;
}

}  // namespace omnimed3d::core
