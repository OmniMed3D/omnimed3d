add_library(core STATIC
    Core.cpp
)
add_library(omnimed3d::core ALIAS core)

target_include_directories(core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

set_target_properties(core PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
)
