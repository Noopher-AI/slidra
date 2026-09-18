// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlidraError } from "../../src/slidra/errors.js";
import { agentSettingsPath, readAgentSettings, writeAgentModel, writeAgentSelection } from "../../src/agent/settings.js";

// Pure filesystem behaviour (no subprocess): every row of NOOP-230 §4.1's
// settings.ts behaviour table, driven purely through SLIDRA_HOME pointed
// at a fresh mkdtemp dir per test — the same isolation pattern chat.test.ts
// already uses for other SLIDRA_HOME-scoped state.
describe("agent settings", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "slidra-settings-"));
    process.env.SLIDRA_HOME = home;
  });

  afterEach(async () => {
    delete process.env.SLIDRA_HOME;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("returns { agent: null } and creates no file when settings.json does not exist", async () => {
    const result = await readAgentSettings();
    expect(result).toEqual({ agent: null, models: {}, adapters: [] });
    await expect(readFile(agentSettingsPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws a SlidraError naming the file path on an empty file", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), "");
    await expect(readAgentSettings()).rejects.toThrow(SlidraError);
    await expect(readAgentSettings()).rejects.toThrow(agentSettingsPath());
  });

  it("throws a SlidraError on invalid JSON", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), "{ not json");
    await expect(readAgentSettings()).rejects.toThrow(SlidraError);
  });

  it("throws a SlidraError when the top level is not an object", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), "[1,2,3]");
    await expect(readAgentSettings()).rejects.toThrow(SlidraError);
  });

  it("returns { agent: null } when the agent field is absent", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({}));
    expect(await readAgentSettings()).toEqual({ agent: null, models: {}, adapters: [] });
  });

  it("returns { agent: null } when the agent field is explicitly null", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: null }));
    expect(await readAgentSettings()).toEqual({ agent: null, models: {}, adapters: [] });
  });

  it("returns every supported stored kind", async () => {
    await mkdir(home, { recursive: true });
    for (const agent of ["claude", "codex", "pi"] as const) {
      await writeFile(agentSettingsPath(), JSON.stringify({ agent }));
      expect(await readAgentSettings()).toEqual({ agent, models: {}, adapters: [] });
    }
  });

  it("throws a SlidraError listing the valid values when agent is an unknown value", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "gemini" }));
    await expect(readAgentSettings()).rejects.toThrow(/claude/);
    await expect(readAgentSettings()).rejects.toThrow(/codex/);
    await expect(readAgentSettings()).rejects.toThrow(/pi/);
  });

  it("writeAgentSelection creates SLIDRA_HOME and the file when neither exists yet", async () => {
    await writeAgentSelection("claude");
    const raw = await readFile(agentSettingsPath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ agent: "claude" });
  });

  it("models: absent reads as {}, a per-kind pick reads back, and a wrong shape is a SlidraError", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "codex", models: { codex: "gpt-5.5" } }));
    expect(await readAgentSettings()).toEqual({ agent: "codex", models: { codex: "gpt-5.5" }, adapters: [] });

    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "codex", models: { codex: 3 } }));
    await expect(readAgentSettings()).rejects.toThrow(SlidraError);
  });

  it("writeAgentModel keeps the other kind's pick, the agent key, and unknown keys", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "claude", models: { codex: "gpt-5.5" }, theme: "dark" }));
    await writeAgentModel("claude", "claude-opus-5");
    expect(JSON.parse(await readFile(agentSettingsPath(), "utf8"))).toEqual({
      agent: "claude",
      models: { codex: "gpt-5.5", claude: "claude-opus-5" },
      theme: "dark",
    });
  });

  it("writeAgentSelection preserves unknown keys already in the file", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "claude", futureKey: "kept" }));
    await writeAgentSelection("codex");
    const raw = await readFile(agentSettingsPath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ agent: "codex", futureKey: "kept" });
  });

  it("writeAgentSelection then readAgentSettings round-trips", async () => {
    await writeAgentSelection("codex");
    expect(await readAgentSettings()).toEqual({ agent: "codex", models: {}, adapters: [] });
  });

  it("a real I/O failure on read (EACCES) propagates as-is, not as { agent: null }", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "claude" }));
    await chmod(agentSettingsPath(), 0o000);
    try {
      await expect(readAgentSettings()).rejects.not.toEqual({ agent: null });
      await expect(readAgentSettings()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      // Restore permissions so afterEach's rm() can clean up.
      await chmod(agentSettingsPath(), 0o600);
    }
  });

  // E10.T6/#400 D4's behaviour table for the `adapters` key.
  describe("declared adapters (settings.json's adapters key)", () => {
    it("absent or empty reads as [], not an error", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(agentSettingsPath(), JSON.stringify({ agent: "claude" }));
      expect((await readAgentSettings()).adapters).toEqual([]);

      await writeFile(agentSettingsPath(), JSON.stringify({ agent: "claude", adapters: {} }));
      expect((await readAgentSettings()).adapters).toEqual([]);
    });

    it("a well-formed entry reads back with defaults filled in (label defaults to the id, args/env default to empty)", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(agentSettingsPath(), JSON.stringify({ adapters: { "my-agent": { command: "/usr/local/bin/my-agent" } } }));
      expect((await readAgentSettings()).adapters).toEqual([
        { id: "my-agent", label: "my-agent", command: "/usr/local/bin/my-agent", args: [], env: {} },
      ]);
    });

    it("a fully-specified entry reads back verbatim", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(
        agentSettingsPath(),
        JSON.stringify({
          adapters: {
            "my-agent": { label: "My Agent", command: "/usr/local/bin/my-agent", args: ["--flag"], env: { FOO: "bar" } },
          },
        }),
      );
      expect((await readAgentSettings()).adapters).toEqual([
        { id: "my-agent", label: "My Agent", command: "/usr/local/bin/my-agent", args: ["--flag"], env: { FOO: "bar" } },
      ]);
    });

    it("extra keys on a declared adapter (writeRules/network/mcp/fileEntry/sandbox) are ignored, not an error", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(
        agentSettingsPath(),
        JSON.stringify({
          adapters: {
            "my-agent": {
              command: "/usr/local/bin/my-agent",
              writeRules: ["/etc"],
              network: { outbound: "unrestricted" },
              mcp: [{ name: "evil" }],
              fileEntry: { localPath: true },
              sandbox: "off",
            },
          },
        }),
      );
      expect((await readAgentSettings()).adapters).toEqual([
        { id: "my-agent", label: "my-agent", command: "/usr/local/bin/my-agent", args: [], env: {} },
      ]);
    });

    it.each([
      ["not an object", JSON.stringify({ adapters: ["not", "an", "object"] })],
      ["an array-valued entry", JSON.stringify({ adapters: { "my-agent": ["not", "an", "object"] } })],
      ["a non-string command", JSON.stringify({ adapters: { "my-agent": { command: 3 } } })],
      ["an empty-string command", JSON.stringify({ adapters: { "my-agent": { command: "" } } })],
      ["missing command entirely", JSON.stringify({ adapters: { "my-agent": {} } })],
      ["a non-array args", JSON.stringify({ adapters: { "my-agent": { command: "x", args: "not-an-array" } } })],
      ["a non-string args entry", JSON.stringify({ adapters: { "my-agent": { command: "x", args: [1] } } })],
      ["a non-object env", JSON.stringify({ adapters: { "my-agent": { command: "x", env: "not-an-object" } } })],
      ["a non-string env value", JSON.stringify({ adapters: { "my-agent": { command: "x", env: { FOO: 1 } } } })],
      ["a non-string label", JSON.stringify({ adapters: { "my-agent": { command: "x", label: 1 } } })],
      ["an id colliding with a built-in kind", JSON.stringify({ adapters: { claude: { command: "x" } } })],
      ["an id with a slash", JSON.stringify({ adapters: { "my/agent": { command: "x" } } })],
      ["an id with '..'", JSON.stringify({ adapters: { "..": { command: "x" } } })],
      ["an id with a space", JSON.stringify({ adapters: { "my agent": { command: "x" } } })],
      ["an id with uppercase", JSON.stringify({ adapters: { MyAgent: { command: "x" } } })],
    ])("rejects: %s", async (_label, json) => {
      await mkdir(home, { recursive: true });
      await writeFile(agentSettingsPath(), json);
      await expect(readAgentSettings()).rejects.toThrow(SlidraError);
    });

    it("the agent field may name a declared adapter's own id, not just a built-in kind", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(
        agentSettingsPath(),
        JSON.stringify({ agent: "my-agent", adapters: { "my-agent": { command: "/usr/local/bin/my-agent" } } }),
      );
      expect((await readAgentSettings()).agent).toBe("my-agent");
    });

    it("agent pointing at neither a built-in kind nor a declared adapter is rejected, listing the actual valid values", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(
        agentSettingsPath(),
        JSON.stringify({ agent: "not-declared", adapters: { "my-agent": { command: "x" } } }),
      );
      await expect(readAgentSettings()).rejects.toThrow(/my-agent/);
    });

    it("env values Slidra always overrides (PATH/SLIDRA_SHIM_TOKEN/SLIDRA_SHIM_BASE_URL) are accepted here — settings.ts has no opinion on them, resolveAdapterConfig/manager.ts overrides them downstream", async () => {
      await mkdir(home, { recursive: true });
      await writeFile(
        agentSettingsPath(),
        JSON.stringify({
          adapters: { "my-agent": { command: "x", env: { PATH: "/evil", SLIDRA_SHIM_TOKEN: "fake", SLIDRA_SHIM_BASE_URL: "http://evil" } } },
        }),
      );
      expect((await readAgentSettings()).adapters).toEqual([
        { id: "my-agent", label: "my-agent", command: "x", args: [], env: { PATH: "/evil", SLIDRA_SHIM_TOKEN: "fake", SLIDRA_SHIM_BASE_URL: "http://evil" } },
      ]);
    });
  });
});
