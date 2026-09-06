import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    // Default 5000ms budget gets tripped under full-suite CPU contention
    // even though every failing test finishes in well under 3s when run
    // alone. 30s gives ~10x headroom while staying far below e2e's 120s,
    // so a genuinely hung test still fails instead of hanging forever.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // packages/web needs a document: the canvas module manipulates real DOM
    // nodes (iframe, srcdoc), and the effects parser reads a slide through
    // DOMParser. Every other package is Node-only server/CLI code and stays
    // on vitest's default "node" environment.
    environmentMatchGlobs: [["packages/web/test/**/*.test.ts", "jsdom"]],
  },
  resolve: {
    alias: {
      // @co-motion/core's package.json points `main` at ./dist/index.js,
      // which only exists after `tsc -b` runs. Tests must pass on a clean
      // checkout with no prior build step, so resolve the workspace package
      // straight to its TypeScript source here instead of relying on a
      // build artifact. This only affects the test runner — published
      // entry points (main/types) are untouched for real consumers.
      "@co-motion/core/text-metrics": path.join(rootDir, "packages/core/src/text-metrics.ts"),
      "@co-motion/core/geometry": path.join(rootDir, "packages/core/src/geometry/index.ts"),
      "@co-motion/core/slide": path.join(rootDir, "packages/core/src/slide/index.ts"),
      "@co-motion/core/text": path.join(rootDir, "packages/core/src/text/index.ts"),
      "@co-motion/core/effects": path.join(rootDir, "packages/core/src/effects/index.ts"),
      "@co-motion/core/clipboard": path.join(rootDir, "packages/core/src/element-clipboard.ts"),
      "@co-motion/core": path.join(rootDir, "packages/core/src/index.ts"),
      // Same reasoning as @co-motion/core above: @co-motion/server's tests
      // import the registry by package name, and must pass on a clean
      // checkout before any `tsc -b` has produced packages/cli/dist.
      "@co-motion/cli": path.join(rootDir, "packages/cli/src/index.ts"),
    },
  },
});
