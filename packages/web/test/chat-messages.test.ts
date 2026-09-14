// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import {
  appendChunkToMessage,
  appendCommandMessage,
  appendMessage,
  appendNoticeMessage,
  appendSystemMessage,
  markUnfinishedCommandsInterrupted,
  restoreChatMessages,
  updateCommandMessage,
  type ChatMessage,
  type PersistedChatEntry,
} from "../src/chat-messages.js";

describe("chat-messages: identity, not position", () => {
  it("appendChunkToMessage updates the message matching the given id even when it is no longer last", () => {
    // The exact scenario this bug fix addresses: the agent's reply starts
    // (id 1), then the author sends a second message (id 2) before the
    // reply finishes — the author's message is now the last item, but the
    // next chunk must still land on the agent's message (id 1), not
    // overwrite the author's.
    const afterFirstChunk: ChatMessage[] = [
      { id: 0, role: "author", text: "the first message" },
      { id: 1, role: "agent", text: "Q3" },
    ];
    const afterAuthorInterrupts = appendMessage(afterFirstChunk, 2, "author", "one more thing");

    const afterSecondChunk = appendChunkToMessage(afterAuthorInterrupts, 1, " earnings report");

    expect(afterSecondChunk).toEqual([
      { id: 0, role: "author", text: "the first message" },
      { id: 1, role: "agent", text: "Q3 earnings report" },
      { id: 2, role: "author", text: "one more thing" },
    ]);
    // The author's own words survive untouched — this is exactly the bug
    // this fix addresses: an unconditional "append to last item" would have
    // deleted "one more thing" and glued " earnings report" onto it instead.
    const authorMessage = afterSecondChunk.find((message) => message.id === 2);
    expect(authorMessage?.text).toBe("one more thing");
  });

  it("appendMessage assigns the given id and never reuses or recomputes it from position", () => {
    const messages = appendMessage(appendMessage([], 5, "author", "a"), 9, "agent", "b");
    expect(messages.map((message) => message.id)).toEqual([5, 9]);
  });

  it("appendChunkToMessage is a no-op on the list when the id is not found", () => {
    const messages: ChatMessage[] = [{ id: 1, role: "agent", text: "hi" }];
    expect(appendChunkToMessage(messages, 999, "!")).toEqual(messages);
  });
});

describe("chat-messages: a command is its own kind of message", () => {
  it("appendCommandMessage records the command verbatim, addressed by its ACP toolCallId", () => {
    const messages = appendCommandMessage([], 0, "call-1", "slidra ls p1", "pending", true);
    expect(messages).toEqual([
      { id: 0, role: "command", toolCallId: "call-1", command: "slidra ls p1", status: "pending", cli: true },
    ]);
  });

  it("updateCommandMessage finds the command by toolCallId even when it is no longer last", () => {
    const started = appendCommandMessage([{ id: 0, role: "author", text: "change the title" }], 1, "call-1", "slidra ls p1", "pending", true);
    const withLaterReply = appendMessage(started, 2, "agent", "changed it");

    const finished = updateCommandMessage(withLaterReply, "call-1", { status: "completed" });

    expect(finished).toEqual([
      { id: 0, role: "author", text: "change the title" },
      { id: 1, role: "command", toolCallId: "call-1", command: "slidra ls p1", status: "completed", cli: true },
      { id: 2, role: "agent", text: "changed it" },
    ]);
  });

  it("updateCommandMessage attaches the failure output to the command that failed", () => {
    const started = appendCommandMessage([], 0, "call-1", "slidra text set p1", "in_progress", true);

    const failed = updateCommandMessage(started, "call-1", {
      status: "failed",
      output: "zsh: command not found: slidra",
    });

    expect(failed).toEqual([
      {
        id: 0,
        role: "command",
        cli: true,
        toolCallId: "call-1",
        command: "slidra text set p1",
        status: "failed",
        output: "zsh: command not found: slidra",
      },
    ]);
  });

  it("updateCommandMessage is a no-op when no command carries that toolCallId", () => {
    const messages: ChatMessage[] = [{ id: 0, role: "agent", text: "hi" }];
    expect(updateCommandMessage(messages, "unknown", { status: "failed" })).toEqual(messages);
  });

  it("appendChunkToMessage never writes reply text into a command message that shares nothing but a neighbourhood", () => {
    const messages = appendCommandMessage([{ id: 0, role: "agent", text: "now let's edit the text: " }], 1, "call-1", "slidra ls p1", "pending", true);

    expect(appendChunkToMessage(messages, 1, "should not appear")).toEqual(messages);
  });
});

describe("chat-messages: a stream interruption is its own fact", () => {
  it.each(["in_progress", "pending"] as const)(
    "marks a command still %s as interrupted without touching its ACP status",
    (status) => {
      const messages = appendCommandMessage([], 0, "call-1", "slidra ls p1", status, true);

      expect(markUnfinishedCommandsInterrupted(messages)).toEqual([
        { id: 0, role: "command", toolCallId: "call-1", command: "slidra ls p1", status, cli: true, interrupted: true },
      ]);
    },
  );

  it("leaves commands that already reached an outcome alone", () => {
    const completed = appendCommandMessage([], 0, "call-1", "slidra ls p1", "completed", true);
    const failed = appendCommandMessage(completed, 1, "call-2", "slidra text set p1", "failed", true);

    expect(markUnfinishedCommandsInterrupted(failed)).toEqual(failed);
  });

  it("leaves speech messages alone", () => {
    const messages: ChatMessage[] = appendMessage([], 0, "agent", "changed it");

    expect(markUnfinishedCommandsInterrupted(messages)).toEqual(messages);
  });

  it("appendNoticeMessage records a notice nobody said, with its own id", () => {
    const messages = appendMessage([], 0, "author", "change the title");

    expect(appendNoticeMessage(messages, 1, "connection lost")).toEqual([
      { id: 0, role: "author", text: "change the title" },
      { id: 1, role: "notice", text: "connection lost" },
    ]);
  });
});

// §7 Decision D3: a system message ("switched to agent X") is not a
// NoticeMessage — that type's existing meaning is "the stream broke, a
// turn's ending was lost" (role="alert"). A routine switch confirmation is
// role="status" and must stay distinguishable from a lost-turn notice.
describe("chat-messages: a system message is neither speech nor a lost-turn notice (D3)", () => {
  it("appendSystemMessage records a system event, with its own id", () => {
    const messages = appendMessage([], 0, "author", "change the title");

    expect(appendSystemMessage(messages, 1, "Switched to Codex. It will handle messages from here.")).toEqual([
      { id: 0, role: "author", text: "change the title" },
      { id: 1, role: "system", text: "Switched to Codex. It will handle messages from here." },
    ]);
  });
});

// [E6.T7]: `GET /api/chat/history`'s persisted shape restored into the same
// `ChatMessage[]` the live SSE stream builds — a page reload/reopened deck
// must render identically to what streamed live.
describe("chat-messages: restoring a persisted thread (GET /api/chat/history)", () => {
  it("restores all four kinds, assigns ids in order starting from startId, and reports the next free id", () => {
    const entries: PersistedChatEntry[] = [
      { entryId: "ce-1", seq: 1, kind: "author", at: "2026-01-01T00:00:00.000Z", text: "change the title to Q3" },
      { entryId: "ce-2", seq: 2, kind: "agent", at: "2026-01-01T00:00:01.000Z", text: "On it." },
      {
        entryId: "cmd-call-1", seq: 3, kind: "command", at: "2026-01-01T00:00:02.000Z",
        text: "slidra text set p1 slides/001.svg el-1 'Q3'", toolCallId: "call-1", status: "completed", cli: true,
      },
      { entryId: "ce-3", seq: 4, kind: "divider", at: "2026-01-01T00:00:03.000Z", text: "Switched to Codex. It will handle messages from here." },
    ];

    const restored = restoreChatMessages(entries, 5);

    expect(restored).toEqual({
      messages: [
        { id: 5, role: "author", text: "change the title to Q3" },
        { id: 6, role: "agent", text: "On it." },
        { id: 7, role: "command", toolCallId: "call-1", command: "slidra text set p1 slides/001.svg el-1 'Q3'", status: "completed", cli: true },
        { id: 8, role: "system", text: "Switched to Codex. It will handle messages from here." },
      ],
      nextId: 9,
    });
  });

  it("carries a failed command's output/blocked/interrupted flags through, and falls back to entryId when toolCallId is absent", () => {
    const entries: PersistedChatEntry[] = [
      {
        entryId: "cmd-call-2", seq: 1, kind: "command", at: "2026-01-01T00:00:00.000Z",
        text: "rm -rf slides/001.svg", cli: false, status: "failed",
        output: "blocked", blocked: true, interrupted: true,
      },
    ];

    const { messages } = restoreChatMessages(entries, 0);

    expect(messages).toEqual([
      {
        id: 0, role: "command", toolCallId: "cmd-call-2", command: "rm -rf slides/001.svg",
        status: "failed", cli: false, output: "blocked", blocked: true, interrupted: true,
      },
    ]);
  });
});
