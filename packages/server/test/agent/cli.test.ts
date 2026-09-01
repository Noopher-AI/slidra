import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runServeCli } from "../../src/cli.js";

// Detection must fail loudly at startup (§3), before any socket is ever
// bound. Pointing PATH at an empty directory means the real
// `commandExistsOnPath` probe genuinely finds neither adapter — this is
// the no-adapter row of the behaviour table, exercised through the actual
// CLI entry point rather than the unit-level `selectAdapter`.
describe("runServeCli — no adapter installed", () => {
  let emptyPathDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    emptyPathDir = await mkdtemp(path.join(tmpdir(), "co-motion-empty-path-"));
    originalPath = process.env.PATH;
    process.env.PATH = emptyPathDir;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(emptyPathDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("exits with an explicit error naming both npm packages, and never starts the server", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runServeCli(["some-presentation-id"]);

    expect(exitCode).toBe(1);
    const messages = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(messages).toContain("@zed-industries/claude-code-acp");
    expect(messages).toContain("@zed-industries/codex-acp");

    errorSpy.mockRestore();
  });
});
