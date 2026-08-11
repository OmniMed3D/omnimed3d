add_library(concurrency STATIC
    Concurrency.cpp
)
add_library(omnimed3d::concurrency ALIAS concurrency)

target_include_directories(concurrency PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

set_target_properties(concurrency PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
)
