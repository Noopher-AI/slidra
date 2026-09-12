// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

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
    expect(result).toEqual({ agent: null, models: {} });
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
    expect(await readAgentSettings()).toEqual({ agent: null, models: {} });
  });

  it("returns { agent: null } when the agent field is explicitly null", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: null }));
    expect(await readAgentSettings()).toEqual({ agent: null, models: {} });
  });

  it("returns the stored kind for claude and codex", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "codex" }));
    expect(await readAgentSettings()).toEqual({ agent: "codex", models: {} });
  });

  it("throws a SlidraError listing the valid values when agent is an unknown value", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "gemini" }));
    await expect(readAgentSettings()).rejects.toThrow(/claude/);
    await expect(readAgentSettings()).rejects.toThrow(/codex/);
  });

  it("writeAgentSelection creates SLIDRA_HOME and the file when neither exists yet", async () => {
    await writeAgentSelection("claude");
    const raw = await readFile(agentSettingsPath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ agent: "claude" });
  });

  it("models: absent reads as {}, a per-kind pick reads back, and a wrong shape is a SlidraError", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "codex", models: { codex: "gpt-5.5" } }));
    expect(await readAgentSettings()).toEqual({ agent: "codex", models: { codex: "gpt-5.5" } });

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
    expect(await readAgentSettings()).toEqual({ agent: "codex", models: {} });
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
});
