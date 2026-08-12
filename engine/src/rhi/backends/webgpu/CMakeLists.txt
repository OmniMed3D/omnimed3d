add_library(rhi_webgpu STATIC
    src/WebGPUDevice.cpp
)
add_library(rhi::webgpu ALIAS rhi_webgpu)

target_include_directories(rhi_webgpu PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(rhi_webgpu PUBLIC rhi::interface)

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
