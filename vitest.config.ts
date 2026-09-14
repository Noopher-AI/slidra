// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default 5000ms budget gets tripped under full-suite CPU contention
    // even though every failing test finishes in well under 3s when run
    // alone. 30s gives ~10x headroom while staying far below e2e's 120s,
    // so a genuinely hung test still fails instead of hanging forever.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // packages/web needs a document: the canvas module manipulates real DOM
    // nodes (iframe, srcdoc), and the effects parser reads a slide through
    // DOMParser. Every other package is Node-only server/CLI code and stays
    // on vitest's "node" environment. Vitest 4 removed environmentMatchGlobs,
    // so each environment is an explicit project in Vitest 5.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["packages/server/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          include: ["packages/web/test/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
