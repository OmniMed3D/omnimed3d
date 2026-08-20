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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite dev",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
  },
});
