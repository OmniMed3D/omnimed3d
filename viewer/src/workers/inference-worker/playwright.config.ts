import { defineConfig, devices } from "@playwright/test";

// Own Playwright config, scoped to inference-worker/'s own bench/e2e --
// deliberately not viewer/playwright.config.ts (Engine-owned, drives the
// full Shell + WASM engine). This one only ever loads bench/index.html,
// which creates nothing but the Inference Worker itself.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // WebGPU EP benchmarking needs a real GPU adapter, not just a
        // WebGPU-capable browser build -- headless Chromium disables the
        // GPU process by default, so navigator.gpu.requestAdapter() would
        // otherwise resolve to null. `--use-angle=metal` is macOS-specific
        // (this benchmark suite is scoped to one MacBook M1, see
        // docs/verification/inference-worker.md's "Test Environment"
        // section) -- a Linux CI runner would need a different ANGLE
        // backend or would fail this adapter check and skip straight to
        // the WASM fallback, which is itself a legitimate thing for
        // REQ-C02's hardware-fallback hierarchy to exercise.
        launchOptions: {
          // --ignore-gpu-blocklist: a macOS CI runner's virtualized GPU
          // hits Chromium's blocklist even though a local physical GPU
          // doesn't, which silently forces every test onto the WASM
          // fallback path instead of the WebGPU path being benchmarked.
          // Matches viewer/playwright.config.ts's (Engine-owned) non-Windows
          // args.
          args: ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
        },
      },
    },
  ],
  webServer: {
    command: "npx vite dev",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
  },
});
