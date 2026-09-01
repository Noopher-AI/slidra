import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ticket #158, A2: a test file that fails to *load* (bad import, syntax
 * error, …) must make `npm run test:e2e` exit non-zero, not get silently
 * skipped. Runs the real `e2e/vitest.config.ts` command in a subprocess
 * against a fixture that only fails to import — asserting on exit code
 * alone, since the vitest error message text is not part of the contract.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const fixture = path.join(e2eDir, "fixtures/loader-failure/broken-import.fixture.ts");

describe("測試檔載入失敗守衛", () => {
  it("import 不到模組的測試檔會讓 vitest 子行程 exit 非 0", () => {
    const result = spawnSync(
      "npx",
      ["vitest", "run", "--config", "e2e/vitest.config.ts", fixture],
      { cwd: rootDir, encoding: "utf-8" },
    );

    expect(result.status).not.toBe(0);
  });
});
