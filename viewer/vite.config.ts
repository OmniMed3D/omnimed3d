import { defineConfig } from "vite";

export default defineConfig({
  root: "src/shell",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  // Real-device testing via a Cloudflare Quick Tunnel (`cloudflared tunnel
  // --url`) fronts either the preview server (`vite preview`) or the dev
  // server (`vite`/`npm run dev`) with a random *.trycloudflare.com
  // subdomain each run -- Vite's Host-header check rejects that by
  // default (each subdomain would need its own allowlist entry, which a
  // fresh tunnel invalidates immediately). A dot-prefixed entry matches
  // the whole subdomain, covering every future tunnel run without needing
  // to update this file again. Both `server` (dev) and `preview` need
  // their own copy -- they're separate config sections, not shared.
  // Required for SharedArrayBuffer, which onnxruntime-web's threaded WASM
  // backend (ort-wasm-simd-threaded) needs for real multi-threading --
  // without these, the page isn't cross-origin-isolated and the threaded
  // WASM binary is documented to silently fall back to a single-threaded
  // path instead of erroring (see inference-worker/vite.config.ts's own
  // copy of these same headers, added there first for its benchmark
  // harness). That graceful-fallback path is exactly what real-device
  // testing (iPhone 14 Pro + Chrome) found is NOT reliably graceful on
  // iOS/WebKit -- a real hu-slice inference (session.run()) crashed the
  // whole page with no catchable error, no WebGPU device-lost event, and
  // no iOS JetsamEvent/crash report at all, isolated via a temporary
  // localStorage-checkpoint trail down to `session.run()` itself, on
  // every combination of low-memory mode / model quantization (FP16,
  // INT8) / execution provider (webgpu, wasm-only) tried -- this was the
  // one remaining untried variable. This app's own vite.config.ts never
  // had these headers even though the sibling inference-worker config
  // did, since the Shell wasn't originally expected to be where heavy
  // threaded-WASM inference actually runs from.
  // Cross-Origin-Resource-Policy, discovered via real Safari Web Inspector
  // (attached over USB -- the first time this session had console access
  // on the actual device, rather than a synthetic localStorage checkpoint
  // trail): Cross-Origin-Embedder-Policy: require-corp requires every
  // resource a Worker's module graph loads to carry an explicit CORP
  // header. Vite's dev server auto-injects its HMR client (`@vite/client`)
  // into every `type: "module"` Worker for live-reload support -- that
  // injected import has no CORP header, and WebKit enforces the
  // requirement more strictly than Chromium does (which let this pass
  // silently, so it never surfaced in any desktop/Playwright testing this
  // session). The console showed exactly this: "Worker load was blocked
  // by Cross-Origin-Embedder-Policy" / "Importing a module script
  // failed" for `@vite/client` -- which broke the Inference Worker's own
  // module import chain, so it silently never finished initializing.
  // "Downloading model..." then hangs forever with zero progress, since
  // the worker that would report progress never came up in the first
  // place -- this explains every "model download stuck" symptom this
  // session, independent of and on top of the real GPU-memory crash
  // investigation.
  server: {
    allowedHosts: [".trycloudflare.com"],
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  preview: {
    allowedHosts: [".trycloudflare.com"],
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
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
