import { describe, expect, it } from "vitest";
import {
  appendChunkToMessage,
  appendCommandMessage,
  appendMessage,
  updateCommandMessage,
  type ChatMessage,
} from "../src/chat-messages.js";

describe("chat-messages: a command is its own kind of message (ticket #17)", () => {
  it("appendCommandMessage records the command verbatim, addressed by its ACP toolCallId", () => {
    const messages = appendCommandMessage([], 0, "call-1", "co-motion ls p1", "pending");
    expect(messages).toEqual([
      { id: 0, role: "command", toolCallId: "call-1", command: "co-motion ls p1", status: "pending" },
    ]);
  });

  it("updateCommandMessage finds the command by toolCallId even when it is no longer last", () => {
    const started = appendCommandMessage([{ id: 0, role: "author", text: "改標題" }], 1, "call-1", "co-motion ls p1", "pending");
    const withLaterReply = appendMessage(started, 2, "agent", "改好了");

    const finished = updateCommandMessage(withLaterReply, "call-1", { status: "completed" });

    expect(finished).toEqual([
      { id: 0, role: "author", text: "改標題" },
      { id: 1, role: "command", toolCallId: "call-1", command: "co-motion ls p1", status: "completed" },
      { id: 2, role: "agent", text: "改好了" },
    ]);
  });

  it("updateCommandMessage attaches the failure output to the command that failed", () => {
    const started = appendCommandMessage([], 0, "call-1", "co-motion text set p1", "in_progress");

    const failed = updateCommandMessage(started, "call-1", {
      status: "failed",
      output: "zsh: command not found: co-motion",
    });

    expect(failed).toEqual([
      {
        id: 0,
        role: "command",
        toolCallId: "call-1",
        command: "co-motion text set p1",
        status: "failed",
        output: "zsh: command not found: co-motion",
      },
    ]);
  });

  it("updateCommandMessage is a no-op when no command carries that toolCallId", () => {
    const messages: ChatMessage[] = [{ id: 0, role: "agent", text: "hi" }];
    expect(updateCommandMessage(messages, "unknown", { status: "failed" })).toEqual(messages);
  });

  it("appendChunkToMessage never writes reply text into a command message that shares nothing but a neighbourhood", () => {
    const messages = appendCommandMessage([{ id: 0, role: "agent", text: "現在來修改文字：" }], 1, "call-1", "co-motion ls p1", "pending");

    expect(appendChunkToMessage(messages, 1, "不該出現")).toEqual(messages);
  });
});
