# CMake platform definition for Emscripten/WebAssembly.
# CMake has no built-in Platform/Emscripten.cmake, so without this file
# CXX_STANDARD/target_compile_features() silently fail to resolve to an
# actual -std= flag (confirmed: flags.make came out empty without this file,
# even though configure/build both reported success) -- verified against
# this repo's own build, not assumed from the reference.

set(CMAKE_C_COMPILE_FEATURES   c_std_99 c_std_11)
set(CMAKE_CXX_COMPILE_FEATURES cxx_std_11 cxx_std_14 cxx_std_17 cxx_std_20)

# Emscripten's compiler is Clang-based; mark it so compiler-ID guards elsewhere work.
set(CMAKE_CXX_COMPILER_ID "Clang" CACHE STRING "" FORCE)
set(CMAKE_C_COMPILER_ID   "Clang" CACHE STRING "" FORCE)

set(CMAKE_SYSTEM_PROCESSOR "wasm32")
