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
    // Required for SharedArrayBuffer, which onnxruntime-web's threaded WASM
    // backend needs to use real multi-threading (Issue #35) -- without
    // these, the threaded WASM binary can silently fall back to a
    // single-threaded path instead of erroring, which would make any
    // WASM-vs-WebGPU comparison measure "browser + a threading bug" rather
    // than a fair baseline.
    // Cross-Origin-Resource-Policy, matching viewer/vite.config.ts's own
    // fix (found there via real Safari Web Inspector, 2026-08-26): under
    // COEP: require-corp, WebKit -- more strictly than Chromium, which
    // let this pass silently -- requires every resource a `type: "module"`
    // Worker's module graph loads to carry an explicit CORP header. Vite's
    // dev server auto-injects its HMR client (`@vite/client`) into every
    // such Worker (this harness's own bench/workerHarness.ts included) but
    // doesn't add this header to it -- without it, WebKit blocks the
    // Worker's own module import chain outright ("Worker load was blocked
    // by Cross-Origin-Embedder-Policy" / "Importing a module script
    // failed"), so `init` never completes. Chromium/Playwright testing
    // never surfaces this, since it doesn't enforce the requirement as
    // strictly -- confirmed missing here only because a real-Safari
    // session (2026-08-27, WebKit routing verification) used this exact
    // harness successfully without it, meaning this gap hadn't actually
    // been exercised by that flow -- added proactively to match Engine's
    // already-fixed config, not because a failure was reproduced here.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  optimizeDeps: {
    // Same onnxruntime-web wasm-asset-resolution issue documented in
    // ../../shell/../../vite.config.ts (viewer/vite.config.ts) -- Vite's
    // dev-time dependency pre-bundling relocates the package without its
    // .wasm binaries, causing a 404. Excluding from pre-bundling avoids it.
    exclude: ["onnxruntime-web"],
  },
});
