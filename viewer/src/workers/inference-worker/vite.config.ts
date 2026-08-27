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
// a hard 100MB capacity and crashes the whole browser process on a file
// this size.
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
    // actually resolve from post-hoisting) -- explicitly setting `fs.allow`
    // replaces Vite's default entirely rather than extending it, so this
    // has to be re-added by hand.
    fs: { allow: [searchForWorkspaceRoot(HERE), AI_PIPELINE_DIR] },
    // Required for SharedArrayBuffer, which onnxruntime-web's threaded WASM
    // backend needs to use real multi-threading -- without these, the
    // threaded WASM binary can silently fall back to a single-threaded
    // path instead of erroring, which would make any WASM-vs-WebGPU
    // comparison measure "browser + a threading bug" rather than a fair
    // baseline.
    //
    // Cross-Origin-Resource-Policy matches viewer/vite.config.ts's own fix:
    // under COEP: require-corp, WebKit -- more strictly than Chromium --
    // requires every resource a `type: "module"` Worker's module graph
    // loads to carry an explicit CORP header. Vite's dev server injects its
    // HMR client (`@vite/client`) into every such Worker but doesn't add
    // this header to it, so without it WebKit blocks the Worker's own
    // module import chain outright and `init` never completes.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  optimizeDeps: {
    // Same onnxruntime-web wasm-asset-resolution issue documented in
    // viewer/vite.config.ts -- Vite's dev-time dependency pre-bundling
    // relocates the package without its .wasm binaries, causing a 404.
    // Excluding from pre-bundling avoids it.
    exclude: ["onnxruntime-web"],
  },
});
