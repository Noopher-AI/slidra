import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * A second, standalone build for text-metrics-entry.ts (ticket #71): its
 * only job is assigning `window.coMotionMeasureText`, so
 * e2e/text-metrics.test.ts can load it via a plain (non-module) `<script>`
 * tag at a predictable, unhashed path.
 *
 * Split out of the main vite.config.ts by NOOP-91: once canvas.ts started
 * importing `@co-motion/core/geometry` (bbox.ts's `<text>` support pulls in
 * the same core/src/text-metrics.ts this entry also uses), building both as
 * entries of ONE Rollup graph made Rollup hoist that now-shared module into
 * a separate chunk and rewrite this entry to `import` it — which silently
 * broke loading it as a classic script (no `type="module"`, per the e2e
 * test above): a syntax error, `window.coMotionMeasureText` never gets set,
 * and the test times out with no other signal. A second Vite build, with no
 * shared module graph with the main app at all, is what keeps this file
 * self-contained again. `npm run build` runs both configs.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@co-motion/core/text-metrics": path.join(rootDir, "../core/src/text-metrics.ts"),
    },
  },
  build: {
    // Never wipe the main config's output — this build must run second (or
    // first; order does not matter, only that neither `emptyOutDir`s the
    // other's files away).
    emptyOutDir: false,
    lib: {
      entry: path.join(rootDir, "src/text-metrics-entry.ts"),
      name: "coMotionTextMetricsEntry",
      formats: ["iife"],
      fileName: () => "text-metrics-entry.js",
    },
  },
});
