import { defineConfig, devices } from "@playwright/test";

// Chromium only -- matches REQ-R07's P0 scope (Google Chrome). Runs
// against Vite's own dev server (root: src/shell, see vite.config.ts) so
// the real cross-package Worker bundling is exercised, not a pre-built
// dist/ snapshot.
//
// Headless Chromium doesn't expose a WebGPU adapter without extra flags
// (empirically confirmed via requestAdapter() returning null otherwise, not
// assumed), and the ANGLE backend flag is OS-specific:
// - macOS: Playwright's own bundled Chromium test build + --use-angle=metal
//   works.
// - Windows (confirmed issue #29): Playwright's bundled Chromium test build
//   requests a WebGPU device successfully with --use-angle=d3d11, but
//   device creation itself then fails ("DynamicLib.Open: dxil.dll Windows
//   Error: 87" -- Dawn's D3D12 DXC shader compiler can't load its own
//   bundled dxil.dll/dxcompiler.dll, despite both files being physically
//   present next to that build's chrome.exe; root cause not pinned down
//   further). The real system Chrome install (`channel: "chrome"`) does
//   not hit this -- used on Windows instead of Playwright's bundled build.
const isWindows = process.platform === "win32";

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
        channel: isWindows ? "chrome" : undefined,
        launchOptions: {
          args: isWindows
            ? ["--use-gl=angle", "--use-angle=d3d11", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
            : ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
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
