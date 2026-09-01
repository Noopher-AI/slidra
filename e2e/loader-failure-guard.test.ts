import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ticket #158, A2: a test file that fails to *load* (bad import, syntax
 * error, …) must make `npm run test:e2e` exit non-zero, not get silently
 * skipped. The main `e2e/vitest.config.ts` include (`e2e/**\/*.test.ts`)
 * never matches the `*.fixture.ts` fixture, so it can't be used here — it
 * would report "no test files found" (also non-zero) without ever
 * attempting to load the fixture. Instead this runs a dedicated config
 * whose include picks up the fixture, so the subprocess actually tries to
 * load it and the resulting failure is a genuine load error.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const fixtureConfig = path.join(e2eDir, "fixtures/loader-failure/vitest.config.ts");

describe("測試檔載入失敗守衛", () => {
  it("import 不到模組的測試檔會讓 vitest 子行程 exit 非 0", () => {
    const result = spawnSync("npx", ["vitest", "run", "--config", fixtureConfig], {
      cwd: rootDir,
      encoding: "utf-8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("No test files found");
  });
});
