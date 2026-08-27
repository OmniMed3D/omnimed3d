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

# Native-only tests (CTest, ships with CMake -- no GoogleTest/Catch2
# dependency). Guarded like engine/'s dicom_inspect: the browser Parse
# Worker never reads a file itself, so this has no WASM equivalent.
# Requires the parent build to have already called enable_testing()
# (engine/CMakeLists.txt does, before add_subdirectory(dicom-parser)) --
# CTest only discovers tests from the directory where enable_testing() was
# first invoked downward.
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

# WASM export layer for the browser Parse Worker
# (viewer/src/workers/parse-worker/) -- a separate build output from the
# engine's own rendering WASM (engine/src/main_wasm.cpp's wasm_smoke and
# successors), which must never link this library in at all (see
# engine/docs/adr/0004-shared-dicom-parser.md). This target is the only
# thing that exists specifically to be loaded by JS as a runnable module;
# the plain `dicom_parser` library above has no JS-callable exports.
if(EMSCRIPTEN)
    add_executable(dicom_parser_wasm wasm/DicomParserWasm.cpp)
    target_link_libraries(dicom_parser_wasm PRIVATE dicom::parser)
    set_target_properties(dicom_parser_wasm PROPERTIES
        CXX_STANDARD 20
        CXX_STANDARD_REQUIRED ON
        SUFFIX ".mjs"
    )

    target_link_options(dicom_parser_wasm PRIVATE
        "SHELL:-s MODULARIZE=1"
        "SHELL:-s EXPORT_ES6=1"
        # "node" alongside "worker": vitest runs pipeline.ts (which loads
        # this module) under Node, not a real browser Worker -- the same
        # artifact needs to run in both, or tests can't load it at all.
        "SHELL:-s ENVIRONMENT=worker,node"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s ASSERTIONS=1"
        # _malloc/_free/HEAPU8: same gap hit and fixed for wasm_smoke
        # (engine/CMakeLists.txt) -- Emscripten doesn't auto-export either
        # unless listed explicitly, even though the runtime uses them
        # internally. _main must stay listed too since setting
        # EXPORTED_FUNCTIONS replaces the implicit default ["_main"] entirely.
        "SHELL:-s EXPORTED_FUNCTIONS=['_main','_malloc','_free','_dicom_wasm_image_info_size','_dicom_wasm_parse_meta','_dicom_wasm_parse_image']"
        "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8']"
    )
endif()
