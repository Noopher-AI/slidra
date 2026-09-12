#!/usr/bin/env node
// A fake ACP agent for [E2.T8]'s ai-collab e2e suite. Same real ACP-over-stdio
// shape as editing-fake-acp-agent.mjs (see that file's own header) — this is
// a separate fixture because its branching is keyed on different message
// content and it exercises `comment`/`slide add` commands, not `text set`.
//
// What it does on the author's first real message (index 1; index 0 is the
// 編輯規約) depends on the message text:
//   - contains "【從大綱規劃】" (the position line Plan with agent puts
//     after `/slidra-plan`, #303 contract §4): requests permission for,
//     then actually runs, `slidra plan set <id> outline '…'` and
//     `plan set <id> design-spec '…'` — a minimal but valid draft plan
//     with one page and one question (contract §1) — and replies
//     「計畫已寫好」. The editor's plan gate opens off that file write
//     (ai-collab.test.ts asserts on `.plan-gate`), not off this reply.
//   - contains "【計畫確認】" (what the gate's 確認並建置 sends, any author
//     message index — it is always the *second* author turn): requests
//     permission for `slidra slide add <id>` (append), holds for
//     E2E_DRAFT_HOLD_MS, then actually runs it and replies 「已建置」 —
//     reports `completed` only if the command succeeds, `failed` (with
//     stdout/stderr) if it doesn't. This fixture never reports success it
//     didn't observe.
//   - contains "寫留言": requests permission for, then actually runs,
//     `slidra comment add … page '<E2E_AGENT_COMMENT>'` (a single-file
//     write, unaffected by the defect above) — AC8(b) needs the write to
//     really land, not just a UI event.
//   - contains "持鎖": reads slides/001.svg to find its `<text id=…>`, then
//     the same request-permission/hold/run dance as editing-fake-acp-agent.mjs's
//     default case, giving AC5's titlebar-frozen screenshot a real,
//     observable freeze window (E2E_FREEZE_HOLD_MS).
//   - anything else, at index 1 or later: echoes the received prompt text
//     back verbatim as an `agent_message_chunk` — this is what AC1's "送出"
//     scenario actually asserts on (proof the comment-context prefix, built
//     server-side by session.ts, really reached the agent; §4.4 of the
//     plan), and also what [E3.T3]'s "送出 /xxx 參數" e2e test asserts on
//     (proof Slidra never rewrites the text before it reaches the agent).
//
// [E3.T3] #232/#236's own two env vars (the `/` command list):
//   - E2E_AVAILABLE_COMMANDS (JSON array of {name, description}): sent as
//     one `available_commands_update` right after `newSession` returns —
//     the agent's *initial* report, before any author turn.
//   - E2E_AVAILABLE_COMMANDS_UPDATE (JSON array): whenever an author
//     message (index >= 1) contains "更新命令", sends this as a second,
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
const agentComment = process.env.E2E_AGENT_COMMENT ?? "agent 透過命令寫的留言";
const availableCommands = process.env.E2E_AVAILABLE_COMMANDS ? JSON.parse(process.env.E2E_AVAILABLE_COMMANDS) : undefined;
const availableCommandsUpdate = process.env.E2E_AVAILABLE_COMMANDS_UPDATE
  ? JSON.parse(process.env.E2E_AVAILABLE_COMMANDS_UPDATE)
  : undefined;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`fake agent 缺少環境變數：${name}`);
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
    if (availableCommandsUpdate && index >= AUTHOR_PROMPT_INDEX && authorText.includes("更新命令")) {
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "available_commands_update", availableCommands: availableCommandsUpdate },
      });
      return { stopReason: "end_turn" };
    }

    // The 編輯規約 turn (index 0) is the agent's own bookkeeping — never
    // echoed, never matched against any branch below.
    if (index < AUTHOR_PROMPT_INDEX) {
      return { stopReason: "end_turn" };
    }

    if (index >= AUTHOR_PROMPT_INDEX && authorText.includes("【從大綱規劃】")) {
      // Contract §1 shapes, kept minimal. Single-quoted for the CLI's argv
      // rules (no `'` inside; JSON's double quotes are fine).
      const outlineFile = "```json\n" + JSON.stringify({
        status: "draft",
        mode: "pyramid",
        pages: [{ n: 1, type: "cover", rhythm: "anchor", title: "e2e 計畫封面" }],
        questions: [{
          id: "mode",
          question: "敘事骨架",
          note: "e2e 假 agent 的建議",
          recommended: "pyramid",
          options: [{ value: "pyramid", label: "結論先行" }, { value: "narrative", label: "故事線" }],
          free_text: true,
        }],
      }) + "\n```\n\n## 第 1 頁\ne2e 假 agent 寫的計畫正文\n";
      const specFile = "```json\n" + JSON.stringify({
        density: "presentation",
        palette: { background: "#FFFFFF", secondary_bg: "#F3F4F6", primary: "#1F3A93", accent: "#E4572E", secondary_accent: "#2A9D8F", text: "#1F1A1A", muted: "#6B7280" },
        type_scale: { cover: 64, section: 56, number: 140, claim: 48, title: 40, subtitle: 28, body: 24, column: 22, caption: 18 },
      }) + "\n```\n";
      await requestAndRun(this.connection, sessionId, "e2e-plan-set-outline", "寫入計畫", `slidra plan set ${presentationId} outline '${outlineFile}'`, this.sessionCwd, 0);
      await requestAndRun(this.connection, sessionId, "e2e-plan-set-spec", "寫入設計規格", `slidra plan set ${presentationId} design-spec '${specFile}'`, this.sessionCwd, 0);
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "計畫已寫好" } },
      });
      return { stopReason: "end_turn" };
    }

    if (index >= AUTHOR_PROMPT_INDEX && authorText.includes("【計畫確認】")) {
      const command = `slidra slide add ${presentationId}`;
      const toolCallId = "e2e-slide-add";

      await requestPermissionFor(this.connection, sessionId, toolCallId, "依計畫建置", command);

      // A real agent reports its own tool-call lifecycle over
      // `session/update`, independently of `session/request_permission`
      // above (the server's own allowlist gate) — this is what actually
      // drives the Running command card (`chat-command-in_progress`).
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId, title: "依計畫建置", kind: "execute", status: "pending", rawInput: { command } },
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
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已建置" } },
      });
      return { stopReason: "end_turn" };
    }

    if (index === AUTHOR_PROMPT_INDEX && authorText.includes("寫留言")) {
      const command = `slidra comment add ${presentationId} ${SLIDE_PATH} page '${agentComment}'`;
      await requestAndRun(this.connection, sessionId, "e2e-comment-add", "新增留言", command, this.sessionCwd, 0);
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已新增留言" } },
      });
      return { stopReason: "end_turn" };
    }

    if (index === AUTHOR_PROMPT_INDEX && authorText.includes("持鎖")) {
      const slide = await this.connection.readTextFile({ sessionId, path: SLIDE_PATH, line: null, limit: null });
      const elementId = extractTextElementId(slide.content);
      const command = `slidra text set ${presentationId} ${SLIDE_PATH} ${elementId} '持鎖測試改過的文字'`;
      const ran = await requestAndRun(this.connection, sessionId, "e2e-text-set", "修改標題文字", command, this.sessionCwd, freezeHoldMs);
      if (!ran) return { stopReason: "cancelled" };
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已鎖定並修改" } },
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
      { kind: "allow_once", name: "允許", optionId: "allow" },
      { kind: "reject_once", name: "拒絕", optionId: "reject" },
    ],
  });
  if (permission.outcome?.outcome !== "selected" || permission.outcome.optionId !== "allow") {
    throw new Error(`命令未獲允許：${JSON.stringify(permission.outcome)}`);
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
  if (!match) throw new Error("投影片裡找不到帶 id 的 <text> 元素");
  return match[1];
}

function runShellCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`命令執行失敗：${command}\n${stdout}\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

new acp.AgentSideConnection((connection) => new CommentFakeAgent(connection), stream);
