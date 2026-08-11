add_library(rhi_interface INTERFACE)
add_library(rhi::interface ALIAS rhi_interface)

target_include_directories(rhi_interface INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
