add_library(rhi_webgpu STATIC
    src/WebGPUDevice.cpp
)
add_library(rhi::webgpu ALIAS rhi_webgpu)

target_include_directories(rhi_webgpu PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(rhi_webgpu PUBLIC rhi::interface omnimed3d::core omnimed3d::utils)

# Compiled shader headers (engine/shaders/generated/*.wgsl.hpp), embedded as
# constexpr C strings by engine/shaders/EmbedShader.cmake -- see
# engine/shaders/CMakeLists.txt.
target_include_directories(rhi_webgpu PRIVATE ${CMAKE_SOURCE_DIR}/shaders/generated)
add_dependencies(rhi_webgpu compile_shaders)

# glm (header-only, camera/projection math for the raymarch UBO) via
# FetchContent, not vcpkg.json -- rhi_webgpu only builds under EMSCRIPTEN
# today (no Vulkan Device implementation exists yet) and the wasm-windows
# preset does not wire in vcpkg's toolchain file at all (confirmed: only
# windows-default/macos-default do), so a vcpkg manifest dependency would
# never resolve here. This matches CLAUDE.md #7's own stated convention
# ("WASM-only deps should use FetchContent") and Mini-Engine-reference's
# identical glm FetchContent block (CMakeLists.txt), version-pinned the
# same way (1.0.1).
include(FetchContent)
FetchContent_Declare(
    glm
    GIT_REPOSITORY https://github.com/g-truc/glm.git
    GIT_TAG 1.0.1
    GIT_SHALLOW TRUE
)
set(GLM_BUILD_LIBRARY OFF CACHE BOOL "" FORCE)
set(GLM_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLM_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(glm)
target_link_libraries(rhi_webgpu PUBLIC glm::glm)

set_target_properties(rhi_webgpu PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
)

# webgpu.h/webgpu_cpp.h ship in emsdk's sysroot already -- no extra include
# path needed. The emdawnwebgpu port (bundled directly in this emsdk, not
# vendored -- see engine/docs/adr/0003) must be requested at both compile
# and link time.
target_compile_options(rhi_webgpu PUBLIC "SHELL:--use-port=emdawnwebgpu")
target_link_options(rhi_webgpu PUBLIC "SHELL:--use-port=emdawnwebgpu")
