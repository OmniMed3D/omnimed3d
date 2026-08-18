// Copies the engine's WASM build output into viewer/src/shell/public/engine/,
// Vite's convention for pre-built assets served as-is (not bundled). Copies
// rather than symlinks for Windows/Mac portability. Requires
// engine/build_wasm/{wasm_smoke.{js,wasm}, dicom-parser/dicom_parser_wasm.{mjs,wasm}}
// to already exist -- build the wasm-macos/wasm-windows CMake preset first
// (see engine's CLAUDE.md §7). Both artifacts come from the same build --
// wasm_smoke is the rendering engine module (classic Module-global output,
// loaded by index.html's inline script), dicom_parser_wasm is the shared
// DICOM parser (ES module output, dynamically imported by parse-worker's
// wasm.ts via the URL passed in its `init` message).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineBuildWasm = join(__dirname, "..", "..", "engine", "build_wasm");
const destRoot = join(__dirname, "..", "src", "shell", "public", "engine");

const files = [
  { src: "wasm_smoke.js", destDir: destRoot },
  { src: "wasm_smoke.wasm", destDir: destRoot },
  { src: "dicom-parser/dicom_parser_wasm.mjs", destDir: join(destRoot, "dicom-parser") },
  { src: "dicom-parser/dicom_parser_wasm.wasm", destDir: join(destRoot, "dicom-parser") },
];

for (const { src } of files) {
  const full = join(engineBuildWasm, src);
  if (!existsSync(full)) {
    console.error(
      `sync-engine-wasm: ${full} not found. Build the engine WASM target first ` +
        `(cd engine && cmake --preset wasm-macos && cmake --build build_wasm, ` +
        `or the wasm-windows equivalent).`,
    );
    process.exit(1);
  }
}

for (const { src, destDir } of files) {
  mkdirSync(destDir, { recursive: true });
  const filename = src.split("/").pop();
  copyFileSync(join(engineBuildWasm, src), join(destDir, filename));
  console.log(`sync-engine-wasm: copied ${src} -> ${destDir}`);
}
