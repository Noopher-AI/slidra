// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Builds to ./dist, which packages/server/src/serve.ts resolves and serves
// statically (see resolveWebDist there). No dev-server proxy config here:
// the API and the built frontend are always served by the same
// slidra-serve process (ADR-0002 — no second backend).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: path.join(rootDir, "index.html"),
        // NOOP-93: the export page loaded by `export/render.ts`'s headless
        // Chromium.
        export: path.join(rootDir, "export.html"),
      },
    },
  },
});
