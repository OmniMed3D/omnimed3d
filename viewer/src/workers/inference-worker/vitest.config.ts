import { defineConfig } from "vitest/config";

// Empty on purpose -- its only job is to stop Vitest's upward config search
// from picking up the workspace root's vite.config.ts (whose `root: "src/shell"`
// is only meaningful for the Shell smoke app and otherwise breaks this
// package's own test file resolution when run via `npm test --workspaces`).
export default defineConfig({});
