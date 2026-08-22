import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds to ./dist, which packages/server/src/serve.ts resolves and serves
// statically (see resolveWebDist there). No dev-server proxy config here:
// the API and the built frontend are always served by the same
// co-motion-serve process (ADR-0002 — no second backend).
export default defineConfig({
  plugins: [react()],
});
