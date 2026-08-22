import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // @co-motion/core's package.json points `main` at ./dist/index.js,
      // which only exists after `tsc -b` runs. Tests must pass on a clean
      // checkout with no prior build step, so resolve the workspace package
      // straight to its TypeScript source here instead of relying on a
      // build artifact. This only affects the test runner — published
      // entry points (main/types) are untouched for real consumers.
      "@co-motion/core": path.join(rootDir, "packages/core/src/index.ts"),
    },
  },
});
