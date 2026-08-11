# Emscripten toolchain file for the WASM/WebGPU build (ADR-0001, engine draft roadmap step 1).
# Informed by Mini-Engine-reference/cmake/EmscriptenToolchain.cmake (read-only reference,
# not copied as-is -- see claude.md #5), verified against this repo's own CMakeLists.txt.

set(CMAKE_SYSTEM_NAME Emscripten)
set(CMAKE_C_COMPILER emcc)
set(CMAKE_CXX_COMPILER em++)
set(EMSCRIPTEN ON)

# Register cmake/Platform/Emscripten.cmake so CMake's Platform/<CMAKE_SYSTEM_NAME>.cmake
# lookup finds it -- without it, CXX_STANDARD/target_compile_features() silently
# resolve to no -std= flag at all (see that file's header comment for how this
# was caught).
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}")

# On Windows, emar/emranlib are .bat wrappers. CMake's compiler-test CreateProcess
# call can't execute a bare `emar` (no .bat extension) on Windows, so it must be
# pointed at the .bat explicitly. Gate on CMAKE_HOST_WIN32 (the host running the
# build), not WIN32 (which reflects the target -- Emscripten -- and would be false).
if(CMAKE_HOST_WIN32 AND DEFINED ENV{EMSDK})
    set(_em "$ENV{EMSDK}/upstream/emscripten")
    set(CMAKE_AR     "${_em}/emar.bat"     CACHE FILEPATH "Emscripten ar"     FORCE)
    set(CMAKE_RANLIB "${_em}/emranlib.bat" CACHE FILEPATH "Emscripten ranlib" FORCE)
else()
    set(CMAKE_AR     emar     CACHE FILEPATH "Emscripten ar")
    set(CMAKE_RANLIB emranlib CACHE FILEPATH "Emscripten ranlib")
endif()

set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

set(CMAKE_CXX_STANDARD 20 CACHE STRING "" FORCE)
set(CMAKE_CXX_STANDARD_REQUIRED ON CACHE BOOL "" FORCE)

# CMAKE_CXX_STANDARD alone isn't enough here: CMake's own compiler-ID detection
# for em++ (via em++.bat on Windows) resolves to an empty CMAKE_CXX_COMPILER_ID
# (verified -- CMakeCXXCompiler.cmake ends up with COMPILER_ID ""), and without a
# resolved compiler ID, CMake has no flag-mapping table to turn CXX_STANDARD 20
# into an actual -std= flag -- flags.make came out with an empty CXX_FLAGS even
# with Platform/Emscripten.cmake's CACHE FORCE compiler-ID override in place (it
# doesn't survive CMake's own detection re-run). Force the flag directly instead
# of depending on that resolution path.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++20")

# Emscripten's compiler-test/try_compile path doesn't support C++20 module
# scanning yet -- must be disabled globally for this toolchain, not just per-target.
set(CMAKE_CXX_SCAN_FOR_MODULES OFF CACHE BOOL "" FORCE)
