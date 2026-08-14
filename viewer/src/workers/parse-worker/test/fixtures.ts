import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../../../..");

export const CT_SMALL_DCM_PATH = path.join(REPO_ROOT, "engine", "tests", "fixtures", "CT_small.dcm");

// Native build output (gitignored) -- run the WASM build first:
//   engine/scripts/emsdk-shell.ps1 "cmake --build build_wasm" -EmsdkDir <emsdk>
export const WASM_MODULE_PATH = path.join(
  REPO_ROOT,
  "engine",
  "build_wasm",
  "dicom-parser",
  "dicom_parser_wasm.mjs",
);
// wasm.ts's dynamic import() needs a proper file:// URL for an absolute
// filesystem path under Node (a bare Windows path like "C:\..." is not a
// valid ESM specifier) -- this conversion is Node-only, kept out of
// wasm.ts itself since that file also needs to work with a plain browser
// asset URL once bundled.
export const WASM_MODULE_URL = pathToFileURL(WASM_MODULE_PATH).href;

export function loadCtSmallDcm(): Uint8Array {
  return new Uint8Array(readFileSync(CT_SMALL_DCM_PATH));
}
