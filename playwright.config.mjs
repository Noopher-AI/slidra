// Browser end-to-end tests (e2e/). The viewer runs under `next dev` on its
// own port so a developer's server on :3000 is never reused by accident.

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.SLIDRA_E2E_PORT ?? 3107);

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.mjs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/decks`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { SLIDRA_DECKS: ["examples", "e2e/.generated"].join(process.platform === "win32" ? ";" : ":"), NEXT_TELEMETRY_DISABLED: "1" },
  },
});
