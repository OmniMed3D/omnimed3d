# Shared DICOM parser library -- consumed by engine/ (native dev/test) and,
# eventually, the Parse Worker (WASM). Lives at the repo root, a sibling of
# engine/viewer/ai-pipeline/infra, rather than nested inside engine/, since
# it's a dependency of two independent build targets, not a private part of
# either. See docs/adr/0001-shared-dicom-parser-module.md.
#
# Not meant to be configured standalone -- consumers add_subdirectory() this
# from their own CMakeLists.txt (see engine/CMakeLists.txt for the pattern).

add_library(dicom_parser STATIC
    src/DicomFile.cpp
)
add_library(dicom::parser ALIAS dicom_parser)

target_include_directories(dicom_parser PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

set_target_properties(dicom_parser PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED ON
)
