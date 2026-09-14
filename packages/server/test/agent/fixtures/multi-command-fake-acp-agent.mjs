#!/usr/bin/env node
// A fake ACP agent for T5's server tests. `fake-acp-agent.mjs`
// scripts at most one command per prompt and never actually executes it;
// `editing-fake-acp-agent.mjs` executes exactly one, for the e2e smoke test.
// T5's own tests need a turn that runs *several* real `slidra` commands
// in sequence (AC1: "one turn's commands undo as one group") and a turn
// that runs none at all, only a read (AC2-b: "thinking doesn't freeze") —
// neither existing fixture can script that, so this is a separate fixture
// rather than another special case bolted onto either.
//
// Configured entirely through FAKE_AGENT_CONFIG (JSON), read once at
// startup:
//   commandsPerTurn: string[][] — commandsPerTurn[i] is the list of full
//     shell command strings (e.g. "slidra text set <id> ...") to run,
//     in order, during the author's (i+1)-th prompt (prompt index 0 is
//     always Slidra's own editorial brief, never scripted here). Each command
//     goes through the real session/request_permission -> sh -c sequence,
//     exactly like editing-fake-acp-agent.mjs, so the server's allowlist
//     and the freeze gate are both really exercised.
//   readOnlyTurns: number[] — 0-based turn indices (matching
//     commandsPerTurn's own indexing) that read `readOnlyPath` via
//     fs/read_text_file and run zero commands — the "agent only thought/
//     read, never touched the floor" case.
//   readOnlyPath: string — virtual path read for a readOnlyTurns entry.
//     Defaults to "slides/001.svg".
//
// FAKE_AGENT_LOG (JSONL, one line per event) records:
//   { pid }                                   — once, at startup.
//   { turn, permissionOutcome }                — one per command, in order.
//   { turn, ranCommand }                       — after that command's shell
//                                                 execution actually finishes.
//   { turn, readOnly: true }                   — a readOnlyTurns turn's read
//                                                 completed.
// A missing/failed permission or shell run throws, which surfaces as
// chat-error on the client side — tests must not need this fixture to
// swallow a failure they should be seeing.

import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { Readable, Writable } from "node:stream";

const config = JSON.parse(process.env.FAKE_AGENT_CONFIG ?? "{}");
const logPath = process.env.FAKE_AGENT_LOG;
const commandsPerTurn = config.commandsPerTurn ?? [];
const readOnlyTurns = new Set(config.readOnlyTurns ?? []);
const readOnlyPath = config.readOnlyPath ?? "slides/001.svg";

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

log({ pid: process.pid });

let promptCount = 0;
let sessionCwd;

class MultiCommandFakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    sessionCwd = params.cwd;
    return { sessionId: "multi-command-fake-session" };
  }

  async prompt(params) {
    const index = promptCount++;
    // Prompt index 0 is always the editorial brief — never scripted, matches every
    // other fixture in this suite (`AUTHOR_PROMPT_INDEX = 1`-style offset).
    const turn = index - 1;

    if (readOnlyTurns.has(turn)) {
      await this.connection.readTextFile({
        sessionId: params.sessionId,
        path: readOnlyPath,
        line: null,
        limit: null,
      });
      log({ turn, readOnly: true });
    } else {
      const commands = commandsPerTurn[turn] ?? [];
      for (const command of commands) {
        const permission = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: `multi-cmd-${turn}-${command}`, title: "Run command", rawInput: { command } },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        });
        log({ turn, permissionOutcome: permission.outcome });
        if (permission.outcome?.outcome !== "selected" || permission.outcome.optionId !== "allow") {
          throw new Error(`command not allowed: ${command}：${JSON.stringify(permission.outcome)}`);
        }
        if (config.holdAfterPermissionMs) {
          await new Promise((resolve) => setTimeout(resolve, config.holdAfterPermissionMs));
        }
        await runShellCommand(command, sessionCwd);
        log({ turn, ranCommand: command });
      }
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `completed turn ${turn} turn` } },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
}

function runShellCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`command failed: ${command}\n${stdout}\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

new acp.AgentSideConnection((connection) => new MultiCommandFakeAgent(connection), stream);
