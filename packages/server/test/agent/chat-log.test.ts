// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatLog, type ChatHistoryEntryInput } from "../../src/agent/chat-log.js";

// Unit level: `ChatLog`'s own batching/segmentation logic, driven with an
// injected `append` so no real `slidra` binary is ever shelled out to —
// `defaultAppend`'s own shape is exercised indirectly by chat.test.ts's
// full-server scenarios instead.

function fakeLog(): { log: ChatLog; calls: ChatHistoryEntryInput[][]; ids: string[] } {
  const calls: ChatHistoryEntryInput[][] = [];
  const ids = ["ce-1", "ce-2", "ce-3", "ce-4", "ce-5"];
  let idIndex = 0;
  let clock = 0;
  const log = new ChatLog("p1", {
    append: async (_id, entries) => {
      calls.push(entries);
    },
    now: () => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}.000Z`,
    nextEntryId: () => ids[idIndex++] ?? `ce-overflow-${idIndex}`,
  });
  return { log, calls, ids };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatLog: message segmentation matches chat-stream.ts's activeReplyId rule", () => {
  it("accumulates consecutive chunks into one agent entry, and a command in between closes it — the next chunk starts a fresh entry", async () => {
    const { log, calls } = fakeLog();

    log.recordAgentChunk("Sure, ");
    log.recordAgentChunk("let me check that.");
    log.recordCommand("call-1", "slidra ls p1", "pending", true);
    log.recordAgentChunk("Done.");

    await log.flush();

    expect(calls).toHaveLength(1);
    const entries = calls[0];
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ entryId: "ce-1", kind: "agent", text: "Sure, let me check that." });
    expect(entries[1]).toMatchObject({ kind: "command", text: "slidra ls p1", meta: { toolCallId: "call-1", status: "pending", cli: true } });
    // A distinct entry, not a continuation of "Sure, let me check that." —
    // proves the command interrupted the sentence rather than being
    // ignored.
    expect(entries[2]).toMatchObject({ entryId: "ce-2", kind: "agent", text: "Done." });
    expect(entries[2].entryId).not.toBe(entries[0].entryId);
  });

  it("endTurn() also closes the open agent entry — a chunk after chat-done starts a new one, not a continuation", async () => {
    const { log, calls } = fakeLog();

    log.recordAgentChunk("first reply");
    log.endTurn();
    log.recordAgentChunk("second reply, later turn");

    await log.flush();

    const texts = calls[0].filter((e) => e.kind === "agent").map((e) => e.text);
    expect(texts).toEqual(["first reply", "second reply, later turn"]);
  });
});

describe("ChatLog: a command's status update upserts the same row", () => {
  it("recordCommandUpdate targets the exact entryId recordCommand created, merging the status/output without touching the command text", async () => {
    const { log, calls } = fakeLog();

    log.recordCommand("call-1", "slidra text set p1 slides/001.svg el-1 'Q3'", "pending", true);
    log.recordCommandUpdate("call-1", { status: "in_progress" });
    log.recordCommandUpdate("call-1", { status: "failed", output: "zsh: command not found: slidra" });

    await log.flush();

    // Three calls to the log coalesce into ONE row in the flushed batch —
    // not three, proving the upsert-by-entryId behaviour, not an append per
    // event.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0]).toEqual({
      entryId: "cmd-call-1",
      kind: "command",
      at: "2026-01-01T00:00:00.000Z",
      text: "slidra text set p1 slides/001.svg el-1 'Q3'",
      meta: { toolCallId: "call-1", status: "failed", cli: true, output: "zsh: command not found: slidra" },
    });
  });
});

describe("ChatLog: a burst of writes flushes as a single append call (debounced)", () => {
  it("coalesces several chunk-sized writes inside the debounce window into exactly one append() call", async () => {
    const { log, calls } = fakeLog();

    log.recordAgentChunk("a");
    log.recordAgentChunk("b");
    log.recordAgentChunk("c");
    expect(calls).toHaveLength(0); // nothing written yet — still inside the debounce window

    await vi.advanceTimersByTimeAsync(500);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1); // "a"+"b"+"c" is one open entry, not three rows
    expect(calls[0][0].text).toBe("abc");
  });

  it("a second burst after the first flush schedules its own, separate append call", async () => {
    const { log, calls } = fakeLog();

    log.recordAuthor("first message");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);

    log.recordAuthor("second message");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    expect(calls[1][0].text).toBe("second message");
  });
});

describe("ChatLog: recordAuthor prefers displayText over the raw text sent to the agent", () => {
  it("persists displayText when given, falls back to text otherwise", async () => {
    const { log, calls } = fakeLog();

    log.recordAuthor("do what the pins say", "(No message entered — sending 2 pinned comment(s) only)");
    log.recordAuthor("plain message");

    await log.flush();

    expect(calls[0].map((e) => e.text)).toEqual(["(No message entered — sending 2 pinned comment(s) only)", "plain message"]);
  });
});

describe("ChatLog: markUnfinishedInterrupted", () => {
  it("marks a still-pending/in_progress command in the unflushed batch as interrupted, leaves a finished one alone", async () => {
    const { log, calls } = fakeLog();

    log.recordCommand("call-1", "slidra ls p1", "in_progress", true);
    log.recordCommand("call-2", "slidra cat p1 project.json", "completed", true);

    log.markUnfinishedInterrupted();
    await log.flush();

    const [pendingOne, completedOne] = calls[0];
    expect(pendingOne.meta).toMatchObject({ status: "in_progress", interrupted: true });
    expect(completedOne.meta).not.toHaveProperty("interrupted");
  });
});
