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
      // Same reasoning, for the direct-manipulation geometry (NOOP-91):
      // geometry/index.ts and slide/index.ts are both declared Node-free,
      // transitively, so canvas.ts can import them straight from source
      // without pulling in workspace.ts's node:fs.
      "@co-motion/core/geometry": path.join(rootDir, "../core/src/geometry/index.ts"),
      "@co-motion/core/slide": path.join(rootDir, "../core/src/slide/index.ts"),
      // Same reasoning again, for the textbox-width handle's live preview
      // (NOOP-91 follow-up): text/index.ts re-exports wrapText and
      // renderTextBoxContent, both declared Node-free — the same
      // `resizeTextBox` (element-text.ts, server-side) calls, so the
      // preview and the eventual write can never disagree.
      "@co-motion/core/text": path.join(rootDir, "../core/src/text/index.ts"),
    },
  },
  build: {
    // text-metrics-entry.ts is now built by a second, standalone Vite
    // config (vite.text-metrics.config.ts) — see that file's header
    // comment for why NOOP-91 forced the split. `npm run build` (below)
    // runs both.
    rollupOptions: {
      input: {
        main: path.join(rootDir, "index.html"),
      },
    },
  },
});
