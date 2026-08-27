# Slang -> WGSL/SPIR-V cross-compilation (ADR-0002). Included
# unconditionally from the top-level CMakeLists.txt (not EMSCRIPTEN-gated)
# -- slangc always runs on the host regardless of which target (native
# Vulkan or WASM/WebGPU) is being configured.
#
# slangc is NOT a vcpkg.json manifest dependency: the wasm-windows CMake
# preset does not use vcpkg's toolchain file (only
# windows-default/macos-default do), so a manifest dependency would never
# be available when configuring the WASM preset. slangc is treated like
# emsdk: an external, per-machine-installed host tool resolved via
# find_program (PATH, or vcpkg's classic install location as a hint).

find_program(SLANGC_EXECUTABLE slangc
    HINTS
        "$ENV{VCPKG_ROOT}/installed/x64-windows/tools/shader-slang"
)

if(NOT SLANGC_EXECUTABLE)
    message(FATAL_ERROR
        "slangc not found. Install it via 'vcpkg install shader-slang' "
        "(classic mode, from your vcpkg root -- this is a host build tool, "
        "not a linked library, so it is not part of engine/vcpkg.json's "
        "manifest) or download a prebuilt release from "
        "https://github.com/shader-slang/slang/releases and ensure slangc "
        "is on PATH.")
endif()

set(SHADER_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/src")
set(SHADER_GENERATED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/generated")
file(MAKE_DIRECTORY "${SHADER_GENERATED_DIR}")

# Compiles one .slang source into WGSL + SPIR-V, then embeds the WGSL
# output as a constexpr C string header -- so the runtime never touches a
# filesystem and needs no Emscripten --preload-file machinery. SPIR-V
# output is generated per ADR-0002 (compiled to both targets) but unused
# today -- no Vulkan Device implementation exists yet; cheap to generate
# now rather than revisit the shader-build step when Vulkan lands.
function(compile_slang_shader NAME SYMBOL)
    set(SLANG_SRC "${SHADER_SRC_DIR}/${NAME}.slang")
    set(WGSL_OUT "${SHADER_GENERATED_DIR}/${NAME}.wgsl")
    set(SPV_OUT "${SHADER_GENERATED_DIR}/${NAME}.spv")
    set(HPP_OUT "${SHADER_GENERATED_DIR}/${NAME}.wgsl.hpp")
    set(EMBED_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/EmbedShader.cmake")

    add_custom_command(
        OUTPUT "${WGSL_OUT}"
        COMMAND "${SLANGC_EXECUTABLE}" "${SLANG_SRC}" -target wgsl -o "${WGSL_OUT}"
        DEPENDS "${SLANG_SRC}"
        COMMENT "slangc: ${NAME}.slang -> ${NAME}.wgsl"
        VERBATIM
    )
    add_custom_command(
        OUTPUT "${SPV_OUT}"
        COMMAND "${SLANGC_EXECUTABLE}" "${SLANG_SRC}" -target spirv -o "${SPV_OUT}"
        DEPENDS "${SLANG_SRC}"
        COMMENT "slangc: ${NAME}.slang -> ${NAME}.spv"
        VERBATIM
    )
    add_custom_command(
        OUTPUT "${HPP_OUT}"
        COMMAND "${CMAKE_COMMAND}"
            "-DIN_FILE=${WGSL_OUT}"
            "-DOUT_FILE=${HPP_OUT}"
            "-DSYMBOL_NAME=${SYMBOL}"
            -P "${EMBED_SCRIPT}"
        DEPENDS "${WGSL_OUT}" "${EMBED_SCRIPT}"
        COMMENT "embed: ${NAME}.wgsl -> ${NAME}.wgsl.hpp"
        VERBATIM
    )

    list(APPEND SHADER_OUTPUTS "${HPP_OUT}" "${SPV_OUT}")
    set(SHADER_OUTPUTS "${SHADER_OUTPUTS}" PARENT_SCOPE)
endfunction()

compile_slang_shader(volume_raymarch kVolumeRaymarchWgsl)
compile_slang_shader(axial_slice kAxialSliceWgsl)
compile_slang_shader(accumulation_blit kAccumulationBlitWgsl)
compile_slang_shader(gradient_bake kGradientBakeWgsl)

add_custom_target(compile_shaders DEPENDS ${SHADER_OUTPUTS})
