#!/usr/bin/env node
// A fake ACP agent for [E2.T8]'s ai-collab e2e suite. Same real ACP-over-stdio
// shape as editing-fake-acp-agent.mjs (see that file's own header) — this is
// a separate fixture because its branching is keyed on different message
// content and it exercises `comment`/`slide add` commands, not `text set`.
//
// What it does on the author's first real message (index 1; index 0 is the
// 編輯規約) depends on the message text:
//   - contains "【從大綱草擬新頁】" (Draft with agent's fixed prefix, §4.8 of
//     the [E2.T8] plan): requests permission for `co-motion slide add
//     --at <N>` (N parsed straight out of the prefix's own "第 N 頁" — this
//     fixture never invents a number the prompt didn't actually carry),
//     holds for E2E_DRAFT_HOLD_MS (so the Running command card has an
//     observable window, AC6), then actually runs it — reports `completed`
//     only if the command succeeds, `failed` (with stdout/stderr) if it
//     doesn't. This fixture never reports success it didn't observe.
//   - contains "寫留言": requests permission for, then actually runs,
//     `co-motion comment add … page '<E2E_AGENT_COMMENT>'` (a single-file
//     write, unaffected by the defect above) — AC8(b) needs the write to
//     really land, not just a UI event.
//   - contains "持鎖": reads slides/001.svg to find its `<text id=…>`, then
//     the same request-permission/hold/run dance as editing-fake-acp-agent.mjs's
//     default case, giving AC5's titlebar-frozen screenshot a real,
//     observable freeze window (E2E_FREEZE_HOLD_MS).
//   - anything else: echoes the received prompt text back verbatim as an
//     `agent_message_chunk` — this is what AC1's "送出" scenario actually
//     asserts on (proof the comment-context prefix, built server-side by
//     session.ts, really reached the agent; §4.4 of the plan).

import * as acp from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { Readable, Writable } from "node:stream";

const SLIDE_PATH = "slides/001.svg";
const AUTHOR_PROMPT_INDEX = 1;

const presentationId = requireEnv("E2E_PRESENTATION_ID");
const draftHoldMs = Number(process.env.E2E_DRAFT_HOLD_MS ?? "0");
const freezeHoldMs = Number(process.env.E2E_FREEZE_HOLD_MS ?? "0");
const agentComment = process.env.E2E_AGENT_COMMENT ?? "agent 透過命令寫的留言";

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
    return { sessionId: "e2e-fake-session" };
  }

  async prompt(params) {
    const index = promptCount++;
    if (index !== AUTHOR_PROMPT_INDEX) {
      return { stopReason: "end_turn" };
    }

    const authorText = extractPromptText(params.prompt);
    const sessionId = params.sessionId;

    if (authorText.includes("【從大綱草擬新頁】")) {
      const match = /在第 (\d+) 頁/.exec(authorText);
      if (!match) throw new Error("prompt 裡找不到「在第 N 頁」——固定前綴的格式變了嗎？");
      const at = match[1];
      const command = `co-motion slide add ${presentationId} --at ${at}`;
      const toolCallId = "e2e-slide-add";

      await requestPermissionFor(this.connection, sessionId, toolCallId, "從大綱插入新頁", command);

      // A real agent reports its own tool-call lifecycle over
      // `session/update`, independently of `session/request_permission`
      // above (the server's own allowlist gate) — this is what actually
      // drives the Running command card (`chat-command-in_progress`,
      // AC6). `editing-fake-acp-agent.mjs` never needed this: every test
      // that fixture serves asserts on the editing lock, not on this card.
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId, title: "從大綱插入新頁", kind: "execute", status: "pending", rawInput: { command } },
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
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "新頁已插入" } },
      });
      return { stopReason: "end_turn" };
    }

    if (authorText.includes("寫留言")) {
      const command = `co-motion comment add ${presentationId} ${SLIDE_PATH} page '${agentComment}'`;
      await requestAndRun(this.connection, sessionId, "e2e-comment-add", "新增留言", command, this.sessionCwd, 0);
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已新增留言" } },
      });
      return { stopReason: "end_turn" };
    }

    if (authorText.includes("持鎖")) {
      const slide = await this.connection.readTextFile({ sessionId, path: SLIDE_PATH, line: null, limit: null });
      const elementId = extractTextElementId(slide.content);
      const command = `co-motion text set ${presentationId} ${SLIDE_PATH} ${elementId} '持鎖測試改過的文字'`;
      await requestAndRun(this.connection, sessionId, "e2e-text-set", "修改標題文字", command, this.sessionCwd, freezeHoldMs);
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已鎖定並修改" } },
      });
      return { stopReason: "end_turn" };
    }

    // Default: echo the received prompt back verbatim — proves the
    // comment-context prefix (session.ts's buildCommentContext) really
    // arrived, in its exact real-time content, not a canned reply.
    await this.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: authorText } },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
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

async function requestAndRun(connection, sessionId, toolCallId, title, command, cwd, holdMs) {
  await requestPermissionFor(connection, sessionId, toolCallId, title, command);
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  await runShellCommand(command, cwd);
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
