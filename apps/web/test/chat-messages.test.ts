import { describe, expect, it } from "vitest";
import {
  appendChunkToMessage,
  appendCommandMessage,
  appendMessage,
  appendNoticeMessage,
  appendSystemMessage,
  markUnfinishedCommandsInterrupted,
  updateCommandMessage,
  type ChatMessage,
} from "../src/chat-messages.js";

describe("chat-messages: identity, not position", () => {
  it("appendChunkToMessage updates the message matching the given id even when it is no longer last", () => {
    // The exact scenario this bug fix addresses: the agent's reply starts
    // (id 1), then the author sends a second message (id 2) before the
    // reply finishes — the author's message is now the last item, but the
    // next chunk must still land on the agent's message (id 1), not
    // overwrite the author's.
    const afterFirstChunk: ChatMessage[] = [
      { id: 0, role: "author", text: "第一則訊息" },
      { id: 1, role: "agent", text: "Q3" },
    ];
    const afterAuthorInterrupts = appendMessage(afterFirstChunk, 2, "author", "還有一件事");

    const afterSecondChunk = appendChunkToMessage(afterAuthorInterrupts, 1, " 財報");

    expect(afterSecondChunk).toEqual([
      { id: 0, role: "author", text: "第一則訊息" },
      { id: 1, role: "agent", text: "Q3 財報" },
      { id: 2, role: "author", text: "還有一件事" },
    ]);
    // The author's own words survive untouched — this is exactly the bug
    // this fix addresses: an unconditional "append to last item" would have
    // deleted "還有一件事" and glued " 財報" onto it instead.
    const authorMessage = afterSecondChunk.find((message) => message.id === 2);
    expect(authorMessage?.text).toBe("還有一件事");
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
    const started = appendCommandMessage([{ id: 0, role: "author", text: "改標題" }], 1, "call-1", "slidra ls p1", "pending", true);
    const withLaterReply = appendMessage(started, 2, "agent", "改好了");

    const finished = updateCommandMessage(withLaterReply, "call-1", { status: "completed" });

    expect(finished).toEqual([
      { id: 0, role: "author", text: "改標題" },
      { id: 1, role: "command", toolCallId: "call-1", command: "slidra ls p1", status: "completed", cli: true },
      { id: 2, role: "agent", text: "改好了" },
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
    const messages = appendCommandMessage([{ id: 0, role: "agent", text: "現在來修改文字：" }], 1, "call-1", "slidra ls p1", "pending", true);

    expect(appendChunkToMessage(messages, 1, "不該出現")).toEqual(messages);
  });
});

describe("chat-messages: a stream interruption is its own fact", () => {
  it("marks a command still running as interrupted without touching its ACP status", () => {
    const messages = appendCommandMessage([], 0, "call-1", "slidra ls p1", "in_progress", true);

    expect(markUnfinishedCommandsInterrupted(messages)).toEqual([
      { id: 0, role: "command", toolCallId: "call-1", command: "slidra ls p1", status: "in_progress", cli: true, interrupted: true },
    ]);
  });

  it("marks a command still pending as interrupted too", () => {
    const messages = appendCommandMessage([], 0, "call-1", "slidra ls p1", "pending", true);

    expect(markUnfinishedCommandsInterrupted(messages)[0]).toMatchObject({ status: "pending", interrupted: true });
  });

  it("leaves commands that already reached an outcome alone", () => {
    const completed = appendCommandMessage([], 0, "call-1", "slidra ls p1", "completed", true);
    const failed = appendCommandMessage(completed, 1, "call-2", "slidra text set p1", "failed", true);

    expect(markUnfinishedCommandsInterrupted(failed)).toEqual(failed);
  });

  it("leaves speech messages alone", () => {
    const messages: ChatMessage[] = appendMessage([], 0, "agent", "改好了");

    expect(markUnfinishedCommandsInterrupted(messages)).toEqual(messages);
  });

  it("appendNoticeMessage records a notice nobody said, with its own id", () => {
    const messages = appendMessage([], 0, "author", "改標題");

    expect(appendNoticeMessage(messages, 1, "連線中斷")).toEqual([
      { id: 0, role: "author", text: "改標題" },
      { id: 1, role: "notice", text: "連線中斷" },
    ]);
  });
});

// §7 Decision D3: a system message ("switched to agent X") is not a
// NoticeMessage — that type's existing meaning is "the stream broke, a
// turn's ending was lost" (role="alert"). A routine switch confirmation is
// role="status" and must stay distinguishable from a lost-turn notice.
describe("chat-messages: a system message is neither speech nor a lost-turn notice (D3)", () => {
  it("appendSystemMessage records a system event, with its own id", () => {
    const messages = appendMessage([], 0, "author", "改標題");

    expect(appendSystemMessage(messages, 1, "已切換到 Codex，接下來的訊息由它處理")).toEqual([
      { id: 0, role: "author", text: "改標題" },
      { id: 1, role: "system", text: "已切換到 Codex，接下來的訊息由它處理" },
    ]);
  });
});
