import { configDefaults, defineConfig } from "vitest/config";

// Its main job is to stop Vitest's upward config search from picking up
// the workspace root's vite.config.ts (whose `root: "src/shell"` is only
// meaningful for the Shell smoke app and otherwise breaks this package's
// own test file resolution when run via `npm test --workspaces`).
//
// e2e/**'s *.spec.ts files use @playwright/test's `test()`, not Vitest's --
// Vitest's default include glob otherwise picks them up and crashes trying
// to run them (see bench:browser in package.json for the real runner).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
