import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve the workspace package to its TS source so tests run without a build.
    alias: {
      repocairn: path.resolve(__dirname, "packages/repocairn/src/index.ts"),
    },
  },
});
