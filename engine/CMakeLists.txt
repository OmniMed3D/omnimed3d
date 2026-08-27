cmake_minimum_required(VERSION 3.28)
project(OmniMed3D-Engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Must precede add_subdirectory(dicom-parser) below -- CTest only discovers
# tests from the directory where enable_testing() was first invoked
# downward, and dicom-parser/CMakeLists.txt registers its own tests via
# add_test() (NFR-04 "core processing pipelines must be verifiable through
# automated testing frameworks").
enable_testing()

add_subdirectory(src/core)
add_subdirectory(src/concurrency)
add_subdirectory(src/utils)

# Slang -> WGSL/SPIR-V shader compilation (ADR-0002). Unconditional (not
# EMSCRIPTEN-gated) -- slangc always runs on the host regardless of which
# target is being configured. See engine/shaders/CMakeLists.txt.
add_subdirectory(shaders)

# WASM/WebGPU path only -- no Vulkan Device implementation exists yet.
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
        # _malloc/_free come from the runtime's libc, not our own
        # EMSCRIPTEN_KEEPALIVE-marked code, so they must be listed
        # explicitly for shell.html's Module._malloc/_free calls to
        # resolve. _main must stay listed too, since setting
        # EXPORTED_FUNCTIONS replaces the implicit default ["_main"].
        "SHELL:-s EXPORTED_FUNCTIONS=['_main','_malloc','_free']"
        # HEAPU8 (used by shell.html to build typed-array views over WASM
        # linear memory for the volume/mask transfer) and UTF8ToString
        # (used by the stats-panel overlay to decode the engine_get_gpu_*
        # char* getters) are runtime-side exports, tracked separately from
        # EXPORTED_FUNCTIONS above.
        "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','UTF8ToString']"
        "SHELL:--shell-file ${CMAKE_CURRENT_SOURCE_DIR}/tests/wasm_smoke/shell.html"
    )
    # Deliberately no -s ASYNCIFY=1 (avoided by design -- WebGPUDevice uses
    # callback-based adapter/device requests, see its header comment) and no
    # -s USE_GLFW=3 (that's for native windowing; this target only needs the
    # HTML canvas).

    # shell.html is baked into the linked output (--shell-file above) but
    # CMake can't infer that from a plain link option string -- without
    # this, NMake won't relink on a shell.html-only change and leaves a
    # stale HTML in build_wasm/.
    set_target_properties(wasm_smoke PROPERTIES
        LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tests/wasm_smoke/shell.html"
    )
endif()
# Shared DICOM parser -- lives at the repo root, a sibling of engine/, not
# nested inside it: it's consumed by both engine (native dev/test) and,
# eventually, the Parse Worker (WASM). Builds unconditionally on native
# and WASM (it parses from an in-memory buffer only and never touches a
# filesystem, see engine/docs/adr/0004-shared-dicom-parser.md), but must
# never be linked into any engine rendering WASM target -- see that ADR
# for why.
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../dicom-parser ${CMAKE_CURRENT_BINARY_DIR}/dicom-parser)

# Native-only: runs the shared parser against a real file. Not built for
# WASM -- the browser Parse Worker gets bytes from the File API via JS and
# never reads a file itself.
if(NOT EMSCRIPTEN)
    add_executable(dicom_inspect src/dicom_inspect.cpp)
    target_link_libraries(dicom_inspect PRIVATE dicom::parser)
    set_target_properties(dicom_inspect PROPERTIES
        CXX_STANDARD 20
        CXX_STANDARD_REQUIRED ON
    )
endif()
