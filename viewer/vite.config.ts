import { defineConfig } from "vite";

export default defineConfig({
  root: "src/shell",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  optimizeDeps: {
    // onnxruntime-web locates its own .wasm assets relative to its
    // package files at runtime; Vite's dev-time dependency pre-bundling
    // relocates those files into node_modules/.vite/deps/ without also
    // copying the .wasm binaries, so the resulting fetch 404s (silently
    // served as index.html by Vite's dev server, which then fails to
    // parse as WASM -- confirmed via network trace, not assumed).
    // Excluding it from pre-bundling keeps its own asset-relative-path
    // logic intact. Production `vite build` is unaffected (already
    // verified working before this fix).
    exclude: ["onnxruntime-web"],
  },
});
