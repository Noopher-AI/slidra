// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { defineConfig } from "vitest/config";

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
});
