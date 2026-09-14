#!/usr/bin/env node
// A fake ACP agent for the browser smoke test (issue #16). It speaks the
// same real JSON-RPC-over-stdio protocol as
// packages/server/test/agent/fixtures/fake-acp-agent.mjs, but it is a
// separate fixture on purpose: that one is *scripted* — it replies with
// canned chunks and never changes the presentation. The browser smoke test
// needs an agent that actually edits the deck, because the whole point of
// the test is that an edit made by the agent reaches the SVG on the canvas.
//
// What it does on the author's first message (prompt index 0 is Slidra's
// own editing-charter turn, so the author's message is index 1) depends on
// the message text (T5/NOOP-110 follow-up, e2e/freeze.test.ts):
//   - default (any text without one of the keywords below, including the
//     original "change the title" trigger some tests still send — the
//     literal phrase left in place because e2e/freeze.test.ts sends it
//     verbatim): unchanged since #16/#8 —
//     1. reads `slides/001.svg` through the ACP client's fs/read_text_file,
//        the same way a real agent discovers the element id;
//     2. asks for permission to run a `slidra text set` shell command,
//        so the server's allowlist is really exercised;
//     3. if permission is granted, runs that command through `sh -c`,
//        resolving `slidra` from PATH — the exact step that was broken
//        during #8's manual acceptance (`command not found: slidra`);
//     4. streams one reply chunk back.
//   - "two steps" (also a literal trigger e2e/freeze.test.ts sends, left
//     as-is for the same reason): same read/permission/hold dance,
//     then TWO `text set` commands in the same turn (second one appends
//     "(step 2)", also asserted verbatim by that file) — exercises one
//     turn's several commands undoing together as a single group (US 44).
//   - "view only" (same note — a literal e2e/freeze.test.ts trigger): reads the
//     slide, holds, replies — never runs any command, so the deck must
//     never freeze (US 48: thinking/reading alone doesn't take the editing
//     lock).
//
// The new title is taken from E2E_NEW_TITLE so the test owns the string it
// asserts on.

import * as acp from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { Readable, Writable } from "node:stream";

const SLIDE_PATH = "slides/001.svg";
const AUTHOR_PROMPT_INDEX = 1;

const newTitle = requireEnv("E2E_NEW_TITLE");
const presentationId = requireEnv("E2E_PRESENTATION_ID");
// T5 (NOOP-93/#110): an artificial pause between the permission grant and
// running the command, so a test needs a real, observable window in which
// the deck is frozen (e2e/freeze.test.ts) rather than racing a turn that
// would otherwise complete within a couple of event-loop ticks. Optional —
// unset/"0" (the default, and every pre-existing consumer of this fixture)
// behaves exactly as before this change.
const freezeHoldMs = Number(process.env.E2E_FREEZE_HOLD_MS ?? "0");

function requireEnv(name) {
  const value = process.env[name];
  // No fallback: a missing variable means the test wired this fixture up
  // wrong, and a silent default would turn that into a mysterious
  // assertion failure much later.
  if (!value) throw new Error(`fake agent is missing environment variable: ${name}`);
  return value;
}

let promptCount = 0;

class EditingFakeAgent {
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

    const slide = await this.connection.readTextFile({
      sessionId: params.sessionId,
      path: SLIDE_PATH,
      line: null,
      limit: null,
    });
    const elementId = extractTextElementId(slide.content);

    if (authorText.includes("view only")) {
      if (freezeHoldMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, freezeHoldMs));
      }
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "just took a look" } },
      });
      return { stopReason: "end_turn" };
    }

    const titles = authorText.includes("two steps") ? [newTitle, `${newTitle} (step 2)`] : [newTitle];
    for (const title of titles) {
      const command = `slidra text set ${presentationId} ${SLIDE_PATH} ${elementId} '${title}'`;
      const permission = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "e2e-text-set", title: "Edit title text", rawInput: { command } },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });
      if (permission.outcome?.outcome !== "selected" || permission.outcome.optionId !== "allow") {
        throw new Error(`command was not allowed: ${JSON.stringify(permission.outcome)}`);
      }

      if (freezeHoldMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, freezeHoldMs));
      }

      await runShellCommand(command, this.sessionCwd);
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "title updated" } },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
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
    // `sh -c` with `slidra` resolved from PATH, exactly as a real agent
    // would run it — so a PATH that cannot reach the CLI fails here loudly.
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

new acp.AgentSideConnection((connection) => new EditingFakeAgent(connection), stream);
