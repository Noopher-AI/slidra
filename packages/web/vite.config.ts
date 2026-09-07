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
      // [E2.T7]: effects/index.ts (schema, value sets, deriveSteps) is
      // declared Node-free too — effects.ts/player-plan.ts import it
      // straight from source, same reasoning as the three aliases above.
      "@co-motion/core/effects": path.join(rootDir, "../core/src/effects/index.ts"),
      // E2.T12: chart/index.ts (model + csv + render + edit) is declared
      // Node-free too — the data window's local preview calls
      // `renderChartSvg` directly (plan §3.6/§4.5), core-rendered markup
      // only, never a second hand-built drawing routine on this side.
      "@co-motion/core/chart": path.join(rootDir, "../core/src/chart/index.ts"),
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
        // NOOP-93: the export page loaded by `export/render.ts`'s headless
        // Chromium. `<script type="module">` (export.html) can take a
        // shared chunk without the classic-script trap
        // vite.text-metrics.config.ts's header comment documents for that
        // other, non-module entry.
        export: path.join(rootDir, "export.html"),
      },
    },
  },
});
