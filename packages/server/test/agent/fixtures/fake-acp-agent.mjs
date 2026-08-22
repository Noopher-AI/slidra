#!/usr/bin/env node
// A scripted fake ACP agent speaking real JSON-RPC over stdio — Seam B's
// counterparty (issue #1's Testing Decisions). It simulates Claude Code; it
// is not a CoMotion module, so driving it over stdio is scripting a
// protocol boundary, not self-verification.
//
// Behaviour is configured entirely through environment variables so each
// test can script a different scenario without command-line plumbing:
//
//   FAKE_AGENT_LOG        - path this script appends one JSON line to per
//                            `session/prompt` call it receives, so tests can
//                            inspect exactly what the client sent (the
//                            編輯規約 as prompt #0, content-block shape,
//                            sessionId reuse). Also logs one line per
//                            `session/new` call, carrying the `cwd` it
//                            received.
//   FAKE_AGENT_CONFIG     - JSON: { authRequired?: boolean, replies?: string[][],
//                            failFirstAttemptMarkerPath?: string }
//                            replies[i] are the text chunks streamed back as
//                            separate agent_message_chunk updates for the
//                            i-th `session/prompt` call (0 = the 編輯規約).
//                            Missing entries fall back to a single echo chunk.
//                            failFirstAttemptMarkerPath: when set, the FIRST
//                            process (across however many separate spawns of
//                            this script share the same marker path) to see
//                            the marker file absent creates it and fails
//                            `newSession` with authRequired; every later
//                            spawn finds the marker present and proceeds
//                            normally. Used to script "first start fails,
//                            retry succeeds" across a real subprocess
//                            respawn, which is what ticket #6 fix 4 is about.
//
// Every process also logs its own pid as the very first log line, so tests
// can check with `process.kill(pid, 0)` whether a given spawn is still
// alive — the direct evidence for "a failed start must not leak its
// subprocess".

import * as acp from "@zed-industries/agent-client-protocol";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const config = JSON.parse(process.env.FAKE_AGENT_CONFIG ?? "{}");
const logPath = process.env.FAKE_AGENT_LOG;

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

log({ pid: process.pid });

let promptCount = 0;

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize(params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: config.authRequired ? [{ id: "fake-login", name: "Fake Login" }] : [],
    };
  }

  async authenticate(_params) {
    return {};
  }

  async newSession(params) {
    // Logged so tests can assert on exactly what cwd the client sent
    // (ticket #6 fix 1: never a real project path, never under
    // CO_MOTION_HOME).
    log({ newSessionCwd: params.cwd });

    const markerPath = config.failFirstAttemptMarkerPath;
    if (markerPath && !existsSync(markerPath)) {
      writeFileSync(markerPath, String(process.pid));
      throw acp.RequestError.authRequired();
    }

    if (config.authRequired) {
      throw acp.RequestError.authRequired();
    }
    return { sessionId: "fake-session-1" };
  }

  async prompt(params) {
    log({ sessionId: params.sessionId, prompt: params.prompt });

    const index = promptCount++;
    const replies = config.replies?.[index] ?? [`回覆第 ${index} 則訊息`];

    if (config.requestPermissionOnPromptIndex === index) {
      const response = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "fake-tool-call", title: "測試工具呼叫" },
        options: [
          { kind: "allow_once", name: "允許", optionId: "allow" },
          { kind: "reject_once", name: "拒絕", optionId: "reject" },
        ],
      });
      log({ permissionOutcome: response.outcome });
    }

    for (const chunk of replies) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
      });
    }

    return { stopReason: "end_turn" };
  }

  async cancel(_params) {}
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
