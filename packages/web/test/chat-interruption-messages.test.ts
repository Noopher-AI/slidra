import { describe, expect, it } from "vitest";
import {
  appendCommandMessage,
  appendMessage,
  appendNoticeMessage,
  markUnfinishedCommandsInterrupted,
  type ChatMessage,
} from "../src/chat-messages.js";

describe("chat-messages: a stream interruption is its own fact (ticket #19)", () => {
  it("marks a command still running as interrupted without touching its ACP status", () => {
    const messages = appendCommandMessage([], 0, "call-1", "co-motion ls p1", "in_progress");

    expect(markUnfinishedCommandsInterrupted(messages)).toEqual([
      { id: 0, role: "command", toolCallId: "call-1", command: "co-motion ls p1", status: "in_progress", interrupted: true },
    ]);
  });

  it("marks a command still pending as interrupted too", () => {
    const messages = appendCommandMessage([], 0, "call-1", "co-motion ls p1", "pending");

    expect(markUnfinishedCommandsInterrupted(messages)[0]).toMatchObject({ status: "pending", interrupted: true });
  });

  it("leaves commands that already reached an outcome alone", () => {
    const completed = appendCommandMessage([], 0, "call-1", "co-motion ls p1", "completed");
    const failed = appendCommandMessage(completed, 1, "call-2", "co-motion text set p1", "failed");

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
