import { defineConfig } from "vite";

export default defineConfig({
  root: "src/shell",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
});
