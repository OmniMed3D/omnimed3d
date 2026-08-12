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
# Shared DICOM parser -- lives at the repo root (docs/adr/0001-shared-dicom-parser-module.md),
# a sibling of engine/, not nested inside it: it's consumed by both engine
# (native dev/test) and, eventually, the Parse Worker (WASM), so it
# shouldn't live inside either one. Builds unconditionally on both native
# and WASM, no EMSCRIPTEN guard, by design: it never touches a filesystem
# itself (parses from an in-memory buffer only, see
# engine/docs/adr/0004-shared-dicom-parser.md), so it's WASM-safe as
# written. It must never be linked into any engine rendering WASM target,
# though -- see that ADR for why (PRD #6.2 "Parser Redundancy
# Reconciliation").
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../dicom-parser ${CMAKE_CURRENT_BINARY_DIR}/dicom-parser)

# Native-only: proves the shared parser against a real file. Not built for
# WASM -- the browser Parse Worker gets bytes from the File API via JS, it
# never reads a file itself (CLAUDE.md #9).
if(NOT EMSCRIPTEN)
    add_executable(dicom_inspect src/dicom_inspect.cpp)
    target_link_libraries(dicom_inspect PRIVATE dicom::parser)
    set_target_properties(dicom_inspect PROPERTIES
        CXX_STANDARD 20
        CXX_STANDARD_REQUIRED ON
    )
endif()

# The EMSCRIPTEN/WebGPU rendering block (rhi/, wasm_smoke) lives on the
# separate feat/engine-webgpu-canvas branch, not yet merged -- deliberately
# not reintroduced here to keep this branch scoped to the DICOM parser
# module only. Re-merge order: this branch or that one, whichever merges
# second picks up the other's addition via a normal (non-conflicting) merge
# once both are just appending to the same two guarded blocks.
