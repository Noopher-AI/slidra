import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A config file of its own, not a new project inside the root
// vitest.config.ts: the browser smoke test must stay out of `npm test`
// (issue #16), and the only way it can stay out is by never being named by
// the default config's `include`. It is run explicitly with
// `npm run test:e2e`.
export default defineConfig({
  root: rootDir,
  test: {
    include: ["e2e/**/*.test.ts"],
    // One real browser, one real server, one real presentation per run —
    // nothing here is worth parallelising, and a single file keeps the
    // output readable.
    fileParallelism: false,
    // Launching Chromium, building a workspace and waiting on a real SSE
    // round trip is far slower than a unit test's default 5s budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    // Same reasoning as the root vitest.config.ts: the workspace packages'
    // `main` fields point at build output, and this test imports their
    // TypeScript sources directly.
    alias: {
      "@co-motion/core/text-metrics": path.join(rootDir, "packages/core/src/text-metrics.ts"),
      "@co-motion/core/geometry": path.join(rootDir, "packages/core/src/geometry/index.ts"),
      "@co-motion/core/slide": path.join(rootDir, "packages/core/src/slide/index.ts"),
      "@co-motion/core/text": path.join(rootDir, "packages/core/src/text/index.ts"),
      "@co-motion/core/embed": path.join(rootDir, "packages/core/src/embed.ts"),
      "@co-motion/core/clipboard": path.join(rootDir, "packages/core/src/element-clipboard.ts"),
      "@co-motion/core/chart": path.join(rootDir, "packages/core/src/chart/index.ts"),
      "@co-motion/core": path.join(rootDir, "packages/core/src/index.ts"),
      "@co-motion/cli": path.join(rootDir, "packages/cli/src/index.ts"),
    },
  },
});
