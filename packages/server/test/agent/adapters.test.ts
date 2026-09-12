import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAdapterConfig } from "../../src/agent/adapters.js";

const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

// NOOP-230 §3.2: both adapters ship as ordinary npm dependencies, resolved
// via `process.execPath` + a real, on-disk file — never PATH, never
// `node_modules/.bin`, never the bin path spawned directly. These tests
// exercise the actual installed packages (no fake/injected resolver): if
// `npm install` has not run, or a package's own file layout drifts, these
// fail loudly instead of a spawn silently failing at runtime.
describe("resolveAdapterConfig", () => {
  it("claude: resolves to a real file on disk, spawned via process.execPath", () => {
    const config = resolveAdapterConfig("claude");
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(existsSync(config.args![0])).toBe(true);
    expect(config.args![0]).toContain(path.join("@zed-industries", "claude-code-acp"));
  });

  it("codex: resolves to a real file on disk, spawned via process.execPath", () => {
    const config = resolveAdapterConfig("codex");
    expect(config.command).toBe(process.execPath);
    expect(config.args?.slice(1)).toEqual([
      "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="read-only"',
    ]);
    expect(existsSync(config.args![0])).toBe(true);
    expect(config.args![0]).toContain(path.join("@zed-industries", "codex-acp"));
  });

  it("claude: points claude-code-acp at the `claude` on PATH (resolved through symlinks) so the model list is the author's own CLI's", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "co-motion-claude-on-path-"));
    const originalPath = process.env.PATH;
    try {
      await writeFile(path.join(dir, "claude-real"), "#!/bin/sh\n", { mode: 0o755 });
      await symlink(path.join(dir, "claude-real"), path.join(dir, "claude"));
      process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
      expect(resolveAdapterConfig("claude").env?.CLAUDE_CODE_EXECUTABLE).toBe(await realpath(path.join(dir, "claude-real")));
      // Codex never gets it — the variable means nothing to codex-acp.
      expect(resolveAdapterConfig("codex").env?.CLAUDE_CODE_EXECUTABLE).toBeUndefined();

      process.env.PATH = dir.replace(/[^/]+$/, "nowhere");
      expect(resolveAdapterConfig("claude").env?.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("package.json pins both adapters to exact versions", async () => {
    const raw = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@zed-industries/claude-code-acp"]).toBe("0.16.2");
    expect(pkg.dependencies["@zed-industries/codex-acp"]).toBe("0.16.0");
  });
});
