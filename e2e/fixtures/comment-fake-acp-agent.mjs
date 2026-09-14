#!/usr/bin/env node
// A fake ACP agent for [E2.T8]'s ai-collab e2e suite. Same real ACP-over-stdio
// shape as editing-fake-acp-agent.mjs (see that file's own header) — this is
// a separate fixture because its branching is keyed on different message
// content and it exercises `comment`/`slide add` commands, not `text set`.
//
// What it does on the author's first real message (index 1; index 0 is the
// agent's own editing-charter turn) depends on the message text:
//   - contains "[plan-from-outline]" (the position line Plan with agent puts
//     after `/slidra-plan`, #303 contract §4 — must keep matching what the
//     real app actually sends): requests permission for, then actually runs,
//     `slidra plan set <id> outline '…'` and `plan set <id> design-spec
//     '…'` — a minimal but valid draft plan with one page and one question
//     (contract §1) — and replies "plan is ready". The editor's plan gate
//     opens off that file write (ai-collab.test.ts asserts on
//     `.plan-gate`), not off this reply.
//   - contains "[plan-confirmed]" (what the gate's confirm-and-build button
//     sends, any author message index — it is always the *second* author
//     turn; sourced from packages/web's plan-file.ts): requests permission for `slidra slide add
//     <id>` (append), holds for E2E_DRAFT_HOLD_MS, then actually runs it
//     and replies "build complete" — reports `completed` only if the
//     command succeeds, `failed` (with stdout/stderr) if it doesn't. This
//     fixture never reports success it didn't observe.
//   - contains "write a comment": requests permission for, then actually
//     runs, `slidra comment add … page '<E2E_AGENT_COMMENT>'` (a
//     single-file write, unaffected by the defect above) — AC8(b) needs
//     the write to really land, not just a UI event.
//   - contains "hold the lock": reads slides/001.svg to find its `<text
//     id=…>`, then the same request-permission/hold/run dance as
//     editing-fake-acp-agent.mjs's default case, giving AC5's
//     titlebar-frozen screenshot a real, observable freeze window
//     (E2E_FREEZE_HOLD_MS).
//   - anything else, at index 1 or later: echoes the received prompt text
//     back verbatim as an `agent_message_chunk` — this is what AC1's
//     "submitting" scenario actually asserts on (proof the comment-context
//     prefix, built server-side by session.ts, really reached the agent;
//     §4.4 of the plan), and also what [E3.T3]'s "sending /xxx with an
//     argument" e2e test asserts on (proof Slidra never rewrites the text
//     before it reaches the agent).
//
// [E3.T3] #232/#236's own two env vars (the `/` command list):
//   - E2E_AVAILABLE_COMMANDS (JSON array of {name, description}): sent as
//     one `available_commands_update` right after `newSession` returns —
//     the agent's *initial* report, before any author turn.
//   - E2E_AVAILABLE_COMMANDS_UPDATE (JSON array): whenever an author
//     message (index >= 1) contains "update commands", sends this as a second,
//     full-replacement `available_commands_update` instead of running any
//     of the branches below — proves a client subscribed to the
//     `agent-commands` SSE event actually reacts to a *later* report, not
//     only the first one.

import * as acp from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { Readable, Writable } from "node:stream";

const SLIDE_PATH = "slides/001.svg";
const AUTHOR_PROMPT_INDEX = 1;

const presentationId = requireEnv("E2E_PRESENTATION_ID");
const draftHoldMs = Number(process.env.E2E_DRAFT_HOLD_MS ?? "0");
const freezeHoldMs = Number(process.env.E2E_FREEZE_HOLD_MS ?? "0");
const agentComment = process.env.E2E_AGENT_COMMENT ?? "comment written by the agent via a command";
const availableCommands = process.env.E2E_AVAILABLE_COMMANDS ? JSON.parse(process.env.E2E_AVAILABLE_COMMANDS) : undefined;
const availableCommandsUpdate = process.env.E2E_AVAILABLE_COMMANDS_UPDATE
  ? JSON.parse(process.env.E2E_AVAILABLE_COMMANDS_UPDATE)
  : undefined;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`fake agent is missing environment variable: ${name}`);
  return value;
}

let promptCount = 0;

class CommentFakeAgent {
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
    this.sessionCwd = params.cwd;
    if (availableCommands) {
      // Sent after the response is decided but before it is returned — a
      // conforming agent's initial report lands between `session/new` and
      // the first author turn (see session.ts's own comment on why
      // `relayingCurrentTurn` must not gate this).
      await this.connection.sessionUpdate({
        sessionId: "e2e-fake-session",
        update: { sessionUpdate: "available_commands_update", availableCommands },
      });
    }
    return { sessionId: "e2e-fake-session" };
  }

  async prompt(params) {
    const index = promptCount++;
    const authorText = extractPromptText(params.prompt);
    const sessionId = params.sessionId;

    // [E3.T3] #232/#236: a later, full-replacement report — checked before
    // the AUTHOR_PROMPT_INDEX gate below (unlike every other branch, this
    // one must also fire for a *second* or later author message).
    if (availableCommandsUpdate && index >= AUTHOR_PROMPT_INDEX && authorText.includes("update commands")) {
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: availableCommandsUpdate },
      });
      return { stopReason: "end_turn" };
    }

    // The editing-charter turn (index 0) is the agent's own bookkeeping —
    // never echoed, never matched against any branch below.
    if (index < AUTHOR_PROMPT_INDEX) {
      return { stopReason: "end_turn" };
    }

    if (index >= AUTHOR_PROMPT_INDEX && authorText.includes("[plan-from-outline]")) {
      // Contract §1 shapes, kept minimal. Single-quoted for the CLI's argv
      // rules (no `'` inside; JSON's double quotes are fine).
      const outlineFile = "```json\n" + JSON.stringify({
        status: "draft",
        mode: "pyramid",
        pages: [{ n: 1, type: "cover", rhythm: "anchor", title: "e2e plan cover" }],
        questions: [{
          id: "mode",
          question: "Narrative skeleton",
          note: "the e2e fake agent's recommendation",
          recommended: "pyramid",
          options: [{ value: "pyramid", label: "Conclusion first" }, { value: "narrative", label: "Story arc" }],
          free_text: true,
        }],
      }) + "\n```\n\n## Page 1\nbody text of the e2e fake agent's plan\n";
      const specFile = "```json\n" + JSON.stringify({
        density: "presentation",
        palette: { background: "#FFFFFF", secondary_bg: "#F3F4F6", primary: "#1F3A93", accent: "#E4572E", secondary_accent: "#2A9D8F", text: "#1F1A1A", muted: "#6B7280" },
        type_scale: { cover: 64, section: 56, number: 140, claim: 48, title: 40, subtitle: 28, body: 24, column: 22, caption: 18 },
      }) + "\n```\n";
      await requestAndRun(this.connection, sessionId, "e2e-plan-set-outline", "Write plan", `slidra plan set ${presentationId} outline '${outlineFile}'`, this.sessionCwd, 0);
      await requestAndRun(this.connection, sessionId, "e2e-plan-set-spec", "Write design spec", `slidra plan set ${presentationId} design-spec '${specFile}'`, this.sessionCwd, 0);
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plan is ready" } },
      });
      return { stopReason: "end_turn" };
    }

    if (index >= AUTHOR_PROMPT_INDEX && authorText.includes("[plan-confirmed]")) {
      const command = `slidra slide add ${presentationId}`;
      const toolCallId = "e2e-slide-add";

      await requestPermissionFor(this.connection, sessionId, toolCallId, "Build per plan", command);

      // A real agent reports its own tool-call lifecycle over
      // `session/update`, independently of `session/request_permission`
      // above (the server's own allowlist gate) — this is what actually
      // drives the Running command card (`chat-command-in_progress`).
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId, title: "Build per plan", kind: "execute", status: "pending", rawInput: { command } },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" },
      });

      if (draftHoldMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, draftHoldMs));
      }

      try {
        await runShellCommand(command, this.sessionCwd);
      } catch (error) {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: error.message } }],
          },
        });
        return { stopReason: "end_turn" };
      }

      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "build complete" } },
      });
      return { stopReason: "end_turn" };
    }

    if (index === AUTHOR_PROMPT_INDEX && authorText.includes("write a comment")) {
      const command = `slidra comment add ${presentationId} ${SLIDE_PATH} page '${agentComment}'`;
      await requestAndRun(this.connection, sessionId, "e2e-comment-add", "Add comment", command, this.sessionCwd, 0);
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "comment added" } },
      });
      return { stopReason: "end_turn" };
    }

    if (index === AUTHOR_PROMPT_INDEX && authorText.includes("hold the lock")) {
      const slide = await this.connection.readTextFile({ sessionId, path: SLIDE_PATH, line: null, limit: null });
      const elementId = extractTextElementId(slide.content);
      const command = `slidra text set ${presentationId} ${SLIDE_PATH} ${elementId} 'text changed by the lock-holding test'`;
      const ran = await requestAndRun(this.connection, sessionId, "e2e-text-set", "Edit title text", command, this.sessionCwd, freezeHoldMs);
      if (!ran) return { stopReason: "cancelled" };
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "locked and edited" } },
      });
      return { stopReason: "end_turn" };
    }

    // Default (any author message, index >= AUTHOR_PROMPT_INDEX, that
    // matched none of the branches above): echo the received prompt back
    // verbatim — proves the comment-context prefix (session.ts's
    // buildCommentContext) really arrived, in its exact real-time content,
    // not a canned reply. Every existing test in this suite sends at most
    // one author message, so widening this from "only index 1" to "index 1
    // or later" does not change any of their outcomes (verified by
    // `grep -n "sendChatMessage" e2e/ai-collab.test.ts`).
    await this.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: authorText } },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {
    // #303: releases whatever hold is pending; the held branch then ends
    // its turn with `cancelled` (see `holdOrCancel`).
    releaseHold?.();
  }
}

async function requestPermissionFor(connection, sessionId, toolCallId, title, command) {
  const permission = await connection.requestPermission({
    sessionId,
    toolCall: { toolCallId, title, rawInput: { command } },
    options: [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ],
  });
  if (permission.outcome?.outcome !== "selected" || permission.outcome.optionId !== "allow") {
    throw new Error(`command was not allowed: ${JSON.stringify(permission.outcome)}`);
  }
}

/**
 * #303: a cancellable hold. Resolves `false` after `holdMs`, or `true` the
 * moment `session/cancel` arrives (`FakeAgent.cancel` calls `releaseHold`).
 */
let releaseHold;
function holdOrCancel(holdMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      releaseHold = undefined;
      resolve(false);
    }, holdMs);
    releaseHold = () => {
      clearTimeout(timer);
      releaseHold = undefined;
      resolve(true);
    };
  });
}

async function requestAndRun(connection, sessionId, toolCallId, title, command, cwd, holdMs) {
  await requestPermissionFor(connection, sessionId, toolCallId, title, command);
  if (holdMs > 0) {
    // #303: the hold is cancellable — `session/cancel` releases it and the
    // turn answers `cancelled` instead of running the command.
    const cancelled = await holdOrCancel(holdMs);
    if (cancelled) return false;
  }
  await runShellCommand(command, cwd);
  return true;
}

function extractPromptText(prompt) {
  return prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function extractTextElementId(svg) {
  const match = /<text[^>]*\bid="([^"]+)"/.exec(svg);
  if (!match) throw new Error("could not find a <text> element with an id in the slide");
  return match[1];
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

new acp.AgentSideConnection((connection) => new CommentFakeAgent(connection), stream);
