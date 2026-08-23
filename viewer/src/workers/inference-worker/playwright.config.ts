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
        // WebGPU EP benchmarking (Issue #35) needs a real GPU adapter, not
        // just a WebGPU-capable browser build -- headless Chromium disables
        // the GPU process by default and navigator.gpu.requestAdapter()
        // resolves to null without these (confirmed directly: identical
        // launch minus these two flags reproducibly returns a null
        // adapter). `--use-angle=metal` is macOS-specific (this project's
        // whole benchmark suite is already scoped to one MacBook M1, see
        // docs/verification/inference-worker.md's "Test Environment"
        // section) -- a Linux CI runner would need a different ANGLE
        // backend (e.g. vulkan) or would fail this adapter check and skip
        // straight to the WASM fallback, which is itself a legitimate
        // thing for REQ-C02's hardware-fallback hierarchy to exercise.
        launchOptions: {
          // --ignore-gpu-blocklist added after this project's real
          // GitHub-hosted macos-latest CI runner returned gpuDetected:false
          // across the board (all tests silently WASM-fallback-passed,
          // some timing assertions then failed from WASM being slower) --
          // a local physical GPU (this suite's dev/verification machine)
          // never hits Chromium's blocklist, but macos-latest's virtualized
          // GPU does. Matches viewer/playwright.config.ts's (Engine-owned)
          // non-Windows args exactly, and spike-webgpu-macos-runner.yml's
          // flags, which is how this gap was found -- that workflow's own
          // inline launch args included this flag, this file's didn't.
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
