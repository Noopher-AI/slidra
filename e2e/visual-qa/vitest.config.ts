import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A config of its own, parallel to e2e/vitest.config.ts: the executor must
// stay out of both `npm test` and `npm run test:e2e` (it is not a
// pass/fail test — it produces screenshots and a manifest), and the only
// way to keep it out is to never let either config's `include` name it.
export default defineConfig({
  root: rootDir,
  test: {
    include: ["e2e/visual-qa/run.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Scenario assertions poll for real server round trips (file writes,
    // live-reload pushes) — vitest's 1s `expect.poll` default is too tight
    // for that, the same reasoning e2e/*.test.ts's per-call `{ timeout }`
    // overrides use, applied once here instead of at every call site.
    expect: { poll: { timeout: 30_000 } },
  },
  resolve: {
    // Same reasoning as e2e/vitest.config.ts: the workspace packages'
    // `main` fields point at build output, and this executor imports their
    // TypeScript sources directly.
    alias: {
      "@co-motion/core/text-metrics": path.join(rootDir, "packages/core/src/text-metrics.ts"),
      "@co-motion/core/geometry": path.join(rootDir, "packages/core/src/geometry/index.ts"),
      "@co-motion/core/slide": path.join(rootDir, "packages/core/src/slide/index.ts"),
      "@co-motion/core/text": path.join(rootDir, "packages/core/src/text/index.ts"),
      "@co-motion/core": path.join(rootDir, "packages/core/src/index.ts"),
      "@co-motion/cli": path.join(rootDir, "packages/cli/src/index.ts"),
    },
  },
});
