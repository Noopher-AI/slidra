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
//                            exitDuringPromptIndex: when the `session/prompt`
//                            call at this index arrives, the process exits
//                            immediately (process.exit(1)) instead of
//                            replying — no response, no further stdio. Used
//                            to script "the adapter dies mid-turn", which is
//                            what fix 1 (round 2) must not let deadlock the
//                            chat forever. Paired with exitOnceMarkerPath so
//                            a respawned process (the session recovering on
//                            the next message) does not exit again.
//                            exitOnceMarkerPath: when set together with
//                            exitDuringPromptIndex, only the first process
//                            (across however many spawns share this marker
//                            path) to see the marker absent creates it and
//                            exits; every later spawn finds the marker
//                            present and replies normally instead.
//                            requestPermissionOnPromptIndex: at this prompt
//                            index, call session/request_permission before
//                            streaming replies. permissionCommand (string,
//                            default "co-motion ls") becomes
//                            toolCall.rawInput.command — this is where
//                            ticket #7's allowlist reads the shell command
//                            from. The outcome is logged as
//                            `{ permissionOutcome }`.
//                            readTextFileOnPromptIndex / readTextFilePath /
//                            readTextFileLine / readTextFileLimit: at this
//                            prompt index, call fs/read_text_file for the
//                            given virtual path (ticket #7). Logs
//                            `{ readTextFileResult: content }` on success or
//                            `{ readTextFileError: { code, message } }` on
//                            failure. readTextFileEveryPromptFrom: like
//                            readTextFileOnPromptIndex but repeats the same
//                            read at every prompt index from this one
//                            onward — used to prove a change made between
//                            two turns is visible on the second read.
//                            writeTextFileOnPromptIndex / writeTextFilePath /
//                            writeTextFileContent: at this prompt index,
//                            call fs/write_text_file (ticket #7 — this must
//                            always fail). Logs
//                            `{ writeTextFileError: { code, message } }` on
//                            failure or `{ writeTextFileResult: true }` if
//                            it unexpectedly succeeds.
//
// Every process also logs its own pid as the very first log line, so tests
// can check with `process.kill(pid, 0)` whether a given spawn is still
// alive — the direct evidence for "a failed start must not leak its
// subprocess".

import * as acp from "@zed-industries/agent-client-protocol";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import path from "node:path";

const config = JSON.parse(process.env.FAKE_AGENT_CONFIG ?? "{}");
const logPath = process.env.FAKE_AGENT_LOG;

// The cwd the client handed us in `session/new` (see `newSession` below) —
// kept so `prompt` can build an absolute `fs/read_text_file` path the same
// way a real, conforming ACP agent does (ticket #7 fix 3): resolve the cwd
// it was given, then join the relative path onto that resolved form. This
// is what actually reproduces the `/var` vs `/private/var` mismatch a real
// `claude-code-acp` 0.12.6 was probed sending on macOS.
let sessionCwd;

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
    sessionCwd = params.cwd;

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

    if (config.exitDuringPromptIndex === index) {
      const markerPath = config.exitOnceMarkerPath;
      const alreadyExited = markerPath && existsSync(markerPath);
      if (!markerPath || !alreadyExited) {
        if (markerPath) writeFileSync(markerPath, String(process.pid));
        // Simulates the adapter dying mid-request: no response is ever
        // sent, stdio just goes away. process.exit() rather than a thrown
        // error, so this matches a real crash/kill, not a clean JSON-RPC
        // error reply.
        process.exit(1);
      }
    }

    const replies = config.replies?.[index] ?? [`回覆第 ${index} 則訊息`];

    if (config.requestPermissionOnPromptIndex === index) {
      const response = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "fake-tool-call",
          title: "測試工具呼叫",
          // permissionOmitCommand scripts a tool call whose rawInput carries
          // no `command` key at all — the "cannot determine the command"
          // case the allowlist must fail closed on (ticket #7).
          rawInput: config.permissionOmitCommand ? {} : { command: config.permissionCommand ?? "co-motion ls" },
        },
        options: [
          { kind: "allow_once", name: "允許", optionId: "allow" },
          { kind: "reject_once", name: "拒絕", optionId: "reject" },
        ],
      });
      log({ permissionOutcome: response.outcome });
    }

    const shouldReadTextFile =
      config.readTextFileOnPromptIndex === index ||
      (config.readTextFileEveryPromptFrom !== undefined && index >= config.readTextFileEveryPromptFrom);
    if (shouldReadTextFile) {
      try {
        // readTextFileAbsoluteUnderCwd: send an *absolute* path built by
        // resolving the session cwd we were given and joining the relative
        // virtual path onto it — the shape a real conforming agent sends
        // (ticket #7 fix 3), as opposed to readTextFilePath, which is sent
        // verbatim (used for plain relative paths and for absolute paths
        // that are deliberately outside the session cwd).
        const requestedPath = config.readTextFileAbsoluteUnderCwd
          ? path.join(realpathSync(sessionCwd), config.readTextFileAbsoluteUnderCwd)
          : config.readTextFilePath;
        const response = await this.connection.readTextFile({
          sessionId: params.sessionId,
          path: requestedPath,
          line: config.readTextFileLine ?? null,
          limit: config.readTextFileLimit ?? null,
        });
        log({ readTextFileResult: response.content });
      } catch (error) {
        log({ readTextFileError: { code: error.code, message: error.message } });
      }
    }

    if (config.writeTextFileOnPromptIndex === index) {
      try {
        await this.connection.writeTextFile({
          sessionId: params.sessionId,
          path: config.writeTextFilePath,
          content: config.writeTextFileContent ?? "",
        });
        log({ writeTextFileResult: true });
      } catch (error) {
        log({ writeTextFileError: { code: error.code, message: error.message } });
      }
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
