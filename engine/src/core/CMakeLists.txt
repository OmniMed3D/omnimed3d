add_library(core STATIC
    Core.cpp
    RenderGraph.cpp
)
add_library(omnimed3d::core ALIAS core)

target_include_directories(core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

set_target_properties(core PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
)

# Native-only: RenderGraph's state-machine logic is plain, GPU-independent
# C++, so it's verified the same no-framework way as dicom-parser's tests
# (hand-rolled assertions wired into CTest) rather than needing a WASM/
# browser harness.
if(NOT EMSCRIPTEN)
    add_executable(core_tests tests/RenderGraphTest.cpp)
    target_link_libraries(core_tests PRIVATE omnimed3d::core)
    set_target_properties(core_tests PROPERTIES
        CXX_STANDARD 20
        CXX_STANDARD_REQUIRED ON
    )
    add_test(NAME core_tests COMMAND core_tests)
endif()
