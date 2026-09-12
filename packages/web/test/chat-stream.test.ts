import { afterEach, describe, expect, it } from "vitest";
import { startChatStream, type ChatStream } from "../src/chat-stream.js";
import type { ChatMessage, CommandMessage } from "../src/chat-messages.js";

// jsdom has no EventSource, so every test drives a fake constructor
// injected via `eventSourceFactory` rather than stubbing a global —
// same approach as live-reload.test.ts.

const CONNECTING = 0;
const CLOSED = 2;

class FakeEventSource {
  url: string;
  closed = false;
  readyState = CONNECTING;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
    this.listeners.clear();
  }

  /** Test helper: simulate the server pushing one named SSE event. */
  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  /** Test helper: a drop EventSource will retry on its own. */
  emitTransientError(): void {
    for (const listener of this.listeners.get("error") ?? []) listener({} as MessageEvent);
  }

  /** Test helper: the browser giving up permanently, then firing `error`. */
  emitPermanentError(): void {
    this.readyState = CLOSED;
    this.emitTransientError();
  }
}

interface Harness {
  fake: FakeEventSource;
  stream: ChatStream;
  messages: ChatMessage[];
  working: boolean;
  streamReady: boolean;
}

function start(): Harness {
  let nextId = 0;
  const harness = {
    messages: [] as ChatMessage[],
    working: false,
    streamReady: false,
  } as Harness;
  harness.stream = startChatStream({
    updateMessages: (update) => {
      harness.messages = update(harness.messages);
    },
    setWorking: (working) => {
      harness.working = working;
    },
    setStreamReady: (ready) => {
      harness.streamReady = ready;
    },
    nextMessageId: () => nextId++,
    eventSourceFactory: (url) => {
      harness.fake = new FakeEventSource(url);
      return harness.fake as unknown as EventSource;
    },
  });
  return harness;
}

const notices = (messages: ChatMessage[]): string[] =>
  messages.filter((m) => m.role === "notice").map((m) => (m as { text: string }).text);

const commands = (messages: ChatMessage[]): CommandMessage[] =>
  messages.filter((m): m is CommandMessage => m.role === "command");

let started: Harness | undefined;

afterEach(() => {
  started?.stream.stop();
  started = undefined;
});

describe("startChatStream", () => {
  it("connects to /api/chat/stream", () => {
    started = start();
    expect(started.fake.url).toBe("/api/chat/stream");
  });

  it("collects a turn's chunks into one agent message and stops working on chat-done", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "好的" });
    started.fake.emit("chat-chunk", { text: "，改好了" });
    expect(started.working).toBe(true);

    started.fake.emit("chat-done");

    expect(started.messages).toEqual([{ id: 0, role: "agent", text: "好的，改好了" }]);
    expect(started.working).toBe(false);
  });

  it("#303: a cancelled turn appends the 「已停止」 system line and marks unfinished commands interrupted", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "開始" });
    started.fake.emit("chat-command", { toolCallId: "t1", command: "co-motion slide add x", status: "in_progress" });

    started.fake.emit("chat-done", { stopReason: "cancelled" });

    expect(started.working).toBe(false);
    expect(started.messages).toEqual([
      { id: 0, role: "agent", text: "開始" },
      { id: 1, role: "command", toolCallId: "t1", command: "co-motion slide add x", status: "in_progress", interrupted: true },
      { id: 2, role: "system", text: "已停止" },
    ]);
  });

  it("clears working when the stream drops mid-turn, so the author is not left in a fake 「工作中」", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "好的" });

    started.fake.emitTransientError();

    expect(started.working).toBe(false);
  });

  it("starts a new message after a mid-turn drop instead of gluing the next turn onto the interrupted one", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "上一輪" });

    started.fake.emitTransientError();
    started.fake.emit("open");
    started.fake.emit("chat-chunk", { text: "下一輪" });

    const texts = started.messages.filter((m) => m.role === "agent").map((m) => (m as { text: string }).text);
    expect(texts).toEqual(["上一輪", "下一輪"]);
  });

  it("marks a command left unfinished by the drop as interrupted, never as failed", () => {
    started = start();
    started.fake.emit("chat-command", { toolCallId: "call-1", command: "co-motion ls p1", status: "in_progress" });

    started.fake.emitTransientError();

    expect(commands(started.messages)).toEqual([
      {
        id: 0,
        role: "command",
        toolCallId: "call-1",
        command: "co-motion ls p1",
        status: "in_progress",
        interrupted: true,
      },
    ]);
  });

  it("tells the author this turn may be incomplete, while EventSource is still reconnecting", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "好的" });

    started.fake.emitTransientError();

    expect(notices(started.messages)).toHaveLength(1);
    expect(notices(started.messages)[0]).toContain("重新連線");
  });

  it("says the connection is gone for good when EventSource has given up", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "好的" });

    started.fake.emitPermanentError();

    expect(notices(started.messages)[0]).toContain("無法自動恢復");
  });

  it("stays silent for a reconnect blip while no turn is in flight", () => {
    started = start();
    started.fake.emit("open");

    started.fake.emitTransientError();
    started.fake.emit("open");
    started.fake.emitTransientError();

    expect(notices(started.messages)).toEqual([]);
  });

  it("does not repeat the notice for each error of the same interrupted turn", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "好的" });

    started.fake.emitTransientError();
    started.fake.emitTransientError();

    expect(notices(started.messages)).toHaveLength(1);
  });

  it("gates sending off on any error and back on when the stream reopens", () => {
    started = start();
    started.fake.emit("open");
    expect(started.streamReady).toBe(true);

    started.fake.emitTransientError();
    expect(started.streamReady).toBe(false);

    started.fake.emit("open");
    expect(started.streamReady).toBe(true);
  });

  it("reports chat-error to the author and ends the turn", () => {
    started = start();
    started.fake.emit("chat-chunk", { text: "好的" });

    started.fake.emit("chat-error", { message: "agent 掛了" });

    // The failure lands in the timeline after the partial reply, not in a banner.
    expect(started.messages.at(-1)).toEqual({ id: 1, role: "error", text: "agent 掛了" });
    expect(started.working).toBe(false);
    // A reported failure is an outcome, not a lost turn — no interruption notice on top of it.
    expect(notices(started.messages)).toEqual([]);
  });

  it("stop() closes the underlying EventSource", () => {
    started = start();
    started.stream.stop();
    expect(started.fake.closed).toBe(true);
  });
});
