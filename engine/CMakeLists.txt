cmake_minimum_required(VERSION 3.28)
project(OmniMed3D-Engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(src/core)
add_subdirectory(src/concurrency)
