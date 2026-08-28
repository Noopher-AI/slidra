import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Builds to ./dist, which packages/server/src/serve.ts resolves and serves
// statically (see resolveWebDist there). No dev-server proxy config here:
// the API and the built frontend are always served by the same
// co-motion-serve process (ADR-0002 — no second backend).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @co-motion/core's package.json `main` points at ./dist/index.js,
      // and index.ts's barrel re-exports workspace.ts, which imports
      // node:fs — that can never bundle for the browser. text-metrics.ts
      // itself has no node: imports, so this alias goes straight to the
      // TypeScript source, bypassing the barrel entirely (ticket #71's
      // plan, decision #9). Kept in lockstep with the same alias in the
      // root vitest.config.ts and e2e/vitest.config.ts.
      "@co-motion/core/text-metrics": path.join(rootDir, "../core/src/text-metrics.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.join(rootDir, "index.html"),
        // A second, standalone entry (ticket #71): its only job is
        // assigning `window.coMotionMeasureText`, so e2e/text-metrics.test.ts
        // can load it directly via a <script> tag, at a predictable,
        // unhashed path (see entryFileNames below) rather than the app's
        // hashed main bundle.
        "text-metrics-entry": path.join(rootDir, "src/text-metrics-entry.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "text-metrics-entry" ? "[name].js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
