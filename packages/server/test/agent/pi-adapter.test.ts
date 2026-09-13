// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdapterConfig } from "../../src/agent/adapters.js";

describe("Pi ACP adapter", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "slidra-pi-acp-home-"));
    process.env.SLIDRA_HOME = home;
  });

  afterEach(async () => {
    delete process.env.SLIDRA_HOME;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("completes a real ACP handshake and exposes only OpenRouter models", async () => {
    const config = resolveAdapterConfig("pi");
    const child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env, OPENROUTER_API_KEY: "test-key-not-used" },
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      );
      const connection = new acp.ClientSideConnection(() => ({
        sessionUpdate: async () => {},
        requestPermission: async (params) => ({
          outcome: {
            outcome: "selected" as const,
            optionId: params.options.find((option) => option.kind === "allow_once")?.optionId ?? params.options[0].optionId,
          },
        }),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
      }), stream);

      const initialized = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      expect(initialized.protocolVersion).toBe(acp.PROTOCOL_VERSION);

      const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      const model = session.configOptions?.find((option) => option.id === "model");
      expect(model?.type).toBe("select");
      if (model?.type !== "select") throw new Error(`Pi did not report a model picker: ${stderr}`);
      expect(model.options.length).toBeGreaterThan(0);
      expect(model.options.every((option) => option.value.startsWith("openrouter/"))).toBe(true);
      expect(model.currentValue.startsWith("openrouter/")).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
    }
  }, 20_000);
});
