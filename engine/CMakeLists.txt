cmake_minimum_required(VERSION 3.28)
project(OmniMed3D-Engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(src/core)
add_subdirectory(src/concurrency)

# WASM/WebGPU path only -- no Vulkan Device implementation exists yet
# (roadmap: docs/current/ENGINE_ROADMAP_WASM_FIRST_2026-08-11.md
# reprioritizes WASM ahead of native Vulkan). The native windows-default
# preset is untouched by this branch.
if(EMSCRIPTEN)
    add_subdirectory(src/rhi)
    add_subdirectory(src/rhi/backends/webgpu)

    add_executable(wasm_smoke src/main_wasm.cpp)
    target_link_libraries(wasm_smoke PRIVATE rhi::webgpu)
    set_target_properties(wasm_smoke PROPERTIES
        CXX_STANDARD 20
        CXX_STANDARD_REQUIRED ON
        SUFFIX ".html"
    )

    target_link_options(wasm_smoke PRIVATE
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s ASSERTIONS=1"
        "SHELL:--shell-file ${CMAKE_CURRENT_SOURCE_DIR}/tests/wasm_smoke/shell.html"
    )
    # Deliberately no -s ASYNCIFY=1 (avoided by design -- WebGPUDevice uses
    # callback-based adapter/device requests, see its header comment) and no
    # -s USE_GLFW=3 (that's for native windowing; this target only needs the
    # HTML canvas).
endif()
