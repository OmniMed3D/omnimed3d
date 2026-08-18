import { defineConfig, devices } from "@playwright/test";

// Chromium only -- matches REQ-R07's P0 scope (Google Chrome). Runs
// against Vite's own dev server (root: src/shell, see vite.config.ts) so
// the real cross-package Worker bundling is exercised, not a pre-built
// dist/ snapshot.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Headless Chromium doesn't expose a WebGPU adapter without
          // these (empirically confirmed via requestAdapter() returning
          // null otherwise, not assumed) -- --use-angle=metal is
          // macOS-specific; a real CI runner on a different OS would
          // need its own equivalent ANGLE backend flag.
          args: ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
        },
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
