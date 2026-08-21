add_library(utils STATIC
    FrameStats.cpp
)
add_library(omnimed3d::utils ALIAS utils)

target_include_directories(utils PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

set_target_properties(utils PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
)
