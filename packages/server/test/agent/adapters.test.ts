// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADAPTER_SPECS, adapterSpecFor, buildAdapterRegistry, isAgentKind, resolveAdapterConfig } from "../../src/agent/adapters.js";

const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

// NOOP-230 §3.2: all adapters ship as ordinary npm dependencies, resolved
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

  it("codex: resolves to a real file on disk, spawned via process.execPath, in the read-only preset", () => {
    const config = resolveAdapterConfig("codex");
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(existsSync(config.args![0])).toBe(true);
    expect(config.args![0]).toContain(path.join("@agentclientprotocol", "codex-acp"));
    expect(config.env?.INITIAL_AGENT_MODE).toBe("read-only");
  });

  it("pi: resolves the bundled ACP executable and writes an isolated local-Qwen catalog", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slidra-pi-home-"));
    const originalHome = process.env.SLIDRA_HOME;
    const originalBaseUrl = process.env.SLIDRA_PI_BASE_URL;
    const originalModel = process.env.SLIDRA_PI_MODEL;
    const originalApiKey = process.env.SLIDRA_PI_API_KEY;
    try {
      process.env.SLIDRA_HOME = dir;
      process.env.SLIDRA_PI_BASE_URL = "http://127.0.0.1:9000/v1";
      process.env.SLIDRA_PI_MODEL = "qwen-test";
      process.env.SLIDRA_PI_API_KEY = "test-local-key";
      const config = resolveAdapterConfig("pi");
      expect(config.command).toBe(process.execPath);
      expect(config.args).toHaveLength(1);
      expect(existsSync(config.args![0])).toBe(true);
      expect(config.args![0]).toContain(path.join("@automatalabs", "pi-acp", "dist", "index.js"));
      const agentDir = path.join(dir, "pi-local-qwen");
      expect(config.env?.PI_CODING_AGENT_DIR).toBe(agentDir);
      expect(config.env?.SLIDRA_PI_API_KEY).toBe("test-local-key");
      expect(config.env?.OPENAI_API_KEY).toBe("");
      expect(config.env?.OPENROUTER_API_KEY).toBe("");
      expect(JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8"))).toEqual({
        providers: {
          "local-qwen": {
            baseUrl: "http://127.0.0.1:9000/v1",
            api: "openai-completions",
            apiKey: "$SLIDRA_PI_API_KEY",
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              thinkingFormat: "qwen-chat-template",
            },
            models: [{ id: "qwen-test", name: "Local Qwen (qwen-test)", reasoning: true }],
          },
        },
      });
    } finally {
      if (originalHome === undefined) delete process.env.SLIDRA_HOME;
      else process.env.SLIDRA_HOME = originalHome;
      if (originalBaseUrl === undefined) delete process.env.SLIDRA_PI_BASE_URL;
      else process.env.SLIDRA_PI_BASE_URL = originalBaseUrl;
      if (originalModel === undefined) delete process.env.SLIDRA_PI_MODEL;
      else process.env.SLIDRA_PI_MODEL = originalModel;
      if (originalApiKey === undefined) delete process.env.SLIDRA_PI_API_KEY;
      else process.env.SLIDRA_PI_API_KEY = originalApiKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("codex: with `codex` on PATH, CODEX_PATH is a launcher in SLIDRA_HOME that execs it with allow_login_shell=false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slidra-codex-on-path-"));
    const originalPath = process.env.PATH;
    const originalHome = process.env.SLIDRA_HOME;
    try {
      await writeFile(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
      process.env.SLIDRA_HOME = path.join(dir, "home");
      const launcher = resolveAdapterConfig("codex").env?.CODEX_PATH;
      expect(launcher).toBe(path.join(dir, "home", "codex-launcher.sh"));
      const text = await readFile(launcher!, "utf8");
      expect(text).toBe(`#!/bin/sh\nexec '${await realpath(path.join(dir, "codex"))}' -c allow_login_shell=false "$@"\n`);
      expect(((await stat(launcher!)).mode & 0o111) !== 0).toBe(true);

      process.env.PATH = dir.replace(/[^/]+$/, "nowhere");
      expect(resolveAdapterConfig("codex").env?.CODEX_PATH).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.SLIDRA_HOME;
      else process.env.SLIDRA_HOME = originalHome;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("claude: points claude-code-acp at the `claude` on PATH (resolved through symlinks) so the model list is the author's own CLI's", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slidra-claude-on-path-"));
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

  it("package.json pins all adapters to exact versions", async () => {
    const raw = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@zed-industries/claude-code-acp"]).toBe("0.16.2");
    expect(pkg.dependencies["@agentclientprotocol/codex-acp"]).toBe("1.11.0");
    expect(pkg.dependencies["@automatalabs/pi-acp"]).toBe("0.8.0");
    expect(pkg.dependencies["@zed-industries/codex-acp"]).toBeUndefined();
  });

  // E10.T6/#400 D4: a user-declared adapter, spawned exactly as declared —
  // no package resolution, no bundled-adapter-specific tweak applied.
  it("resolves a custom (user-declared) adapter to its own command/args/env verbatim, with no CLAUDE_CODE_EXECUTABLE/CODEX_PATH/Pi tweak applied", () => {
    const registry = buildAdapterRegistry([
      { id: "my-agent", label: "My Agent", command: "/usr/local/bin/my-agent", args: ["--flag"], env: { FOO: "bar" } },
    ]);
    const config = resolveAdapterConfig("my-agent", registry);
    expect(config).toEqual({ kind: "my-agent", label: "My Agent", command: "/usr/local/bin/my-agent", args: ["--flag"], env: { FOO: "bar" } });
  });

  it("a custom adapter's own declared env still loses to Slidra's SLIDRA_BIN-derived PATH prefix when SLIDRA_BIN is set", () => {
    const originalBin = process.env.SLIDRA_BIN;
    try {
      process.env.SLIDRA_BIN = "/opt/slidra/slidra";
      const registry = buildAdapterRegistry([{ id: "my-agent", label: "My Agent", command: "x", args: [], env: { PATH: "/evil" } }]);
      const config = resolveAdapterConfig("my-agent", registry);
      expect(config.env?.PATH).toBe("/opt/slidra:/evil");
    } finally {
      if (originalBin === undefined) delete process.env.SLIDRA_BIN;
      else process.env.SLIDRA_BIN = originalBin;
    }
  });
});

describe("buildAdapterRegistry", () => {
  it("built-ins come first, in ADAPTER_SPECS's own order, followed by every declared adapter in declaration order", () => {
    const registry = buildAdapterRegistry([
      { id: "b-agent", label: "B", command: "b", args: [], env: {} },
      { id: "a-agent", label: "A", command: "a", args: [], env: {} },
    ]);
    expect(registry.map((spec) => spec.kind)).toEqual([...ADAPTER_SPECS.map((spec) => spec.kind), "b-agent", "a-agent"]);
  });

  it("a declared adapter's spec carries writeRules: [] and no probeCommand/loginCommand", () => {
    const registry = buildAdapterRegistry([{ id: "my-agent", label: "My Agent", command: "x", args: [], env: {} }]);
    const spec = adapterSpecFor("my-agent", registry);
    expect(spec.writeRules).toEqual([]);
    expect(spec.probeCommand).toBeUndefined();
    expect(spec.loginCommand).toBeUndefined();
  });

  it("empty declared list is identical to ADAPTER_SPECS itself", () => {
    expect(buildAdapterRegistry([])).toEqual(ADAPTER_SPECS);
  });
});

describe("isAgentKind(value, registry)", () => {
  it("true for every built-in kind against the default registry, and for a declared adapter's own id against its registry", () => {
    for (const spec of ADAPTER_SPECS) expect(isAgentKind(spec.kind, ADAPTER_SPECS)).toBe(true);
    const registry = buildAdapterRegistry([{ id: "my-agent", label: "My Agent", command: "x", args: [], env: {} }]);
    expect(isAgentKind("my-agent", registry)).toBe(true);
  });

  it("false for a declared adapter's id against a registry that never declared it, and for any non-string", () => {
    expect(isAgentKind("my-agent", ADAPTER_SPECS)).toBe(false);
    expect(isAgentKind(undefined, ADAPTER_SPECS)).toBe(false);
    expect(isAgentKind(3, ADAPTER_SPECS)).toBe(false);
  });
});
