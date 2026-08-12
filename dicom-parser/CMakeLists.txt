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

# Native-only automated tests (CTest, ships with CMake -- no GoogleTest/
# Catch2 dependency, per claude.md #4). Guarded like engine/'s dicom_inspect:
# the browser Parse Worker never reads a file itself (CLAUDE.md #9 "No host
# filesystem on WASM"), so this has no WASM equivalent. Requires the parent
# build to have already called enable_testing() (engine/CMakeLists.txt does,
# before add_subdirectory(dicom-parser)) -- CTest only discovers tests from
# the directory where enable_testing() was first invoked downward.
if(NOT EMSCRIPTEN)
    add_executable(dicom_parser_tests tests/DicomFileTest.cpp)
    target_link_libraries(dicom_parser_tests PRIVATE dicom::parser)
    set_target_properties(dicom_parser_tests PROPERTIES
        CXX_STANDARD 20
        CXX_STANDARD_REQUIRED ON
    )
    # The fixture lives under engine/tests/fixtures/ (owned by engine's
    # dicom_inspect tool) rather than duplicated here -- safe to reference by
    # relative path because dicom-parser/ is always a sibling of engine/ in
    # this monorepo's fixed layout (docs/adr/0001-shared-dicom-parser-module.md);
    # this library isn't meant to be dropped into other repos standalone.
    target_compile_definitions(dicom_parser_tests PRIVATE
        "CT_SMALL_DCM_PATH=\"${CMAKE_CURRENT_SOURCE_DIR}/../engine/tests/fixtures/CT_small.dcm\""
    )

    add_test(NAME dicom_parser_tests COMMAND dicom_parser_tests)
endif()
