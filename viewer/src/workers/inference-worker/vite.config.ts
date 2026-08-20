import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ai-pipeline/ (FP32 model + its 116MB external-data companion) is outside
// this package and outside the viewer/ workspace Vite would otherwise
// auto-detect as the allowed fs root -- explicitly allow-listed below so
// bench.ts can fetch it via Vite's own /@fs/ static-file serving. Serving
// it this way (a real HTTP response from Vite's dev server) rather than
// via Playwright's page.route().fulfill() is required, not a style choice:
// route.fulfill() proxies the body through Chromium's CDP pipe, which has
// a hard 100MB capacity -- confirmed by a real crash
// ("Too large read data is pending: capacity=104857600 ... Connection
// closed, not enough capacity") the first time this benchmark tried to
// route the 116MB file that way, killing the whole browser process before
// the page even loaded.
const AI_PIPELINE_DIR = path.resolve(HERE, "../../../../ai-pipeline");

// Minimal standalone dev server for bench/ (real-browser latency
// benchmark harness) -- deliberately not the Shell's vite.config.ts, so
// this stays inside inference-worker/'s own CODEOWNERS scope and doesn't
// pull in the Engine WASM build as a dependency for a benchmark that only
// needs the Inference Worker itself.
export default defineConfig({
  root: "bench",
  server: {
    port: 5174,
    // searchForWorkspaceRoot(HERE) restores Vite's own default allow-root
    // (the viewer/ workspace root, where onnxruntime-web's wasm assets
    // actually resolve from post-hoisting -- confirmed by a real 403 the
    // first time this only allow-listed HERE and AI_PIPELINE_DIR) --
    // explicitly setting `fs.allow` replaces Vite's default entirely
    // rather than extending it, so this has to be re-added by hand.
    fs: { allow: [searchForWorkspaceRoot(HERE), AI_PIPELINE_DIR] },
  },
  optimizeDeps: {
    // Same onnxruntime-web wasm-asset-resolution issue documented in
    // ../../shell/../../vite.config.ts (viewer/vite.config.ts) -- Vite's
    // dev-time dependency pre-bundling relocates the package without its
    // .wasm binaries, causing a 404. Excluding from pre-bundling avoids it.
    exclude: ["onnxruntime-web"],
  },
});
