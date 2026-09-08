import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

  it("package.json pins both adapters to exact versions", async () => {
    const raw = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@zed-industries/claude-code-acp"]).toBe("0.16.2");
    expect(pkg.dependencies["@zed-industries/codex-acp"]).toBe("0.16.0");
  });
});
