import { describe, expect, it } from "vitest";
import { appendChunkToMessage, appendMessage, type ChatMessage } from "../src/chat-messages.js";

describe("chat-messages: identity, not position", () => {
  it("appendChunkToMessage updates the message matching the given id even when it is no longer last", () => {
    // The exact scenario from ticket #6 fix 3: the agent's reply starts
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
    // The author's own words survive untouched — this is the bug fix 3
    // exists for: an unconditional "append to last item" would have
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
