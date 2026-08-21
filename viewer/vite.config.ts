import { defineConfig } from "vite";

export default defineConfig({
  root: "src/shell",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  preview: {
    // Real-device testing via a Cloudflare Quick Tunnel (`cloudflared tunnel
    // --url`) fronts the preview server with a random *.trycloudflare.com
    // subdomain each run -- Vite's Host-header check rejects that by
    // default (each subdomain would need its own allowlist entry, which a
    // fresh tunnel invalidates immediately). A dot-prefixed entry matches
    // the whole subdomain, covering every future tunnel run without
    // needing to update this file again.
    allowedHosts: [".trycloudflare.com"],
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
