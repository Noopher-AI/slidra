import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveReload } from "../src/live-reload.js";
import type { LiveReload } from "../src/live-reload.js";

// jsdom has no EventSource, so every test drives a fake constructor
// injected via `eventSourceFactory` rather than stubbing a global.

// Mirrors the standard EventSource readyState values this fake needs.
const CONNECTING = 0;
const CLOSED = 2;

class FakeEventSource {
  url: string;
  closed = false;
  // Real EventSource starts CONNECTING and moves to OPEN on `open`; tests
  // that care about the CLOSED transition set this directly to simulate
  // the browser giving up permanently.
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
    // A real EventSource stops delivering events once closed; clearing
    // listeners here makes the fake behave the same way instead of only
    // flipping a flag nothing else checks.
    this.listeners.clear();
  }

  /** Test helper: simulate the server pushing one named SSE event. */
  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  /** Test helper: simulate a bare `error` event without ending the stream. */
  emitError(): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({} as MessageEvent);
    }
  }

  /** Test helper: simulate the browser permanently giving up, then firing `error`. */
  emitPermanentError(): void {
    this.readyState = CLOSED;
    this.emitError();
  }
}

let liveReload: LiveReload | undefined;

afterEach(() => {
  liveReload?.stop();
  liveReload = undefined;
});

describe("startLiveReload", () => {
  it("connects to /api/events", () => {
    let created: FakeEventSource | undefined;
    liveReload = startLiveReload({
      onChange: () => {},
      eventSourceFactory: (url) => {
        created = new FakeEventSource(url) as unknown as EventSource;
        return created as unknown as EventSource;
      },
    });

    expect(created?.url).toBe("/api/events");
  });

  it("calls onChange when the stream opens, so an initial connection reloads too", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("open");

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("calls onChange again on every reconnection, recovering an edit made during the gap", () => {
    // EventSource reconnects automatically after any network interruption
    // — the normal case, not an exotic one — and openEventStream has no
    // replay, so the client must treat every re-open as "something may
    // have been missed" rather than only reacting to a change event that
    // happens to arrive after reconnecting.
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("open"); // initial connection
    // An edit happens while disconnected — the client never sees it as an
    // event, only as the reconnection itself.
    fake!.emit("open"); // EventSource's automatic reconnect

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("calls onChange when a presentation-changed event arrives", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("presentation-changed");

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("calls onChange again for each subsequent presentation-changed event", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("presentation-changed");
    fake!.emit("presentation-changed");
    fake!.emit("presentation-changed");

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("calls onFrozenChange(true) on editing-frozen and onFrozenChange(false) on editing-unfrozen", () => {
    let fake: FakeEventSource | undefined;
    const onFrozenChange = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onFrozenChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("editing-frozen");
    expect(onFrozenChange).toHaveBeenNthCalledWith(1, true);

    fake!.emit("editing-unfrozen");
    expect(onFrozenChange).toHaveBeenNthCalledWith(2, false);
  });

  it("editing-frozen/editing-unfrozen never trigger onChange — they are not a reload signal", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      onFrozenChange: () => {},
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });
    onChange.mockClear(); // drop the initial "open" call

    fake!.emit("editing-frozen");
    fake!.emit("editing-unfrozen");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onSaveStateChange with the parsed save-state payload (NOOP-93)", () => {
    let fake: FakeEventSource | undefined;
    const onSaveStateChange = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onSaveStateChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("save-state", { known: true, dirty: true, fileName: "deck.comot" });
    expect(onSaveStateChange).toHaveBeenNthCalledWith(1, { known: true, dirty: true, fileName: "deck.comot" });

    fake!.emit("save-state", { known: false });
    expect(onSaveStateChange).toHaveBeenNthCalledWith(2, { known: false });
  });

  it("save-state never triggers onChange — it is not a reload signal", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      onSaveStateChange: () => {},
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });
    onChange.mockClear(); // drop the initial "open" call

    fake!.emit("save-state", { known: true, dirty: true, fileName: "deck.comot" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onExportEvent for each export SSE event, in every legal shape (NOOP-93 §4.4)", () => {
    let fake: FakeEventSource | undefined;
    const onExportEvent = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onExportEvent,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("export", { jobId: "j1", format: "pdf", state: "queued" });
    fake!.emit("export", { jobId: "j1", format: "pdf", state: "running", totalFrames: 3, completedFrames: 0 });
    fake!.emit("export", { jobId: "j1", format: "pdf", state: "progress", totalFrames: 3, completedFrames: 2 });
    fake!.emit("export", {
      jobId: "j1",
      format: "pdf",
      state: "done",
      totalFrames: 3,
      completedFrames: 3,
      pageCount: 3,
      fileName: "deck.pdf",
      downloadPath: "/api/export/j1/file",
    });
    fake!.emit("export", { jobId: "j2", format: "pdf-frames", state: "error", message: "模擬失敗" });

    expect(onExportEvent).toHaveBeenNthCalledWith(1, { jobId: "j1", format: "pdf", state: "queued" });
    expect(onExportEvent).toHaveBeenNthCalledWith(2, {
      jobId: "j1",
      format: "pdf",
      state: "running",
      totalFrames: 3,
      completedFrames: 0,
    });
    expect(onExportEvent).toHaveBeenNthCalledWith(3, {
      jobId: "j1",
      format: "pdf",
      state: "progress",
      totalFrames: 3,
      completedFrames: 2,
    });
    expect(onExportEvent).toHaveBeenNthCalledWith(4, {
      jobId: "j1",
      format: "pdf",
      state: "done",
      totalFrames: 3,
      completedFrames: 3,
      pageCount: 3,
      fileName: "deck.pdf",
      downloadPath: "/api/export/j1/file",
    });
    expect(onExportEvent).toHaveBeenNthCalledWith(5, { jobId: "j2", format: "pdf-frames", state: "error", message: "模擬失敗" });
  });

  it("drops a malformed export payload instead of fabricating a state", () => {
    let fake: FakeEventSource | undefined;
    const onExportEvent = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onExportEvent,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("export", { jobId: "j1", format: "docx", state: "queued" });
    fake!.emit("export", { jobId: "j1", format: "pdf", state: "unknown-state" });
    fake!.emit("export", { format: "pdf", state: "queued" }); // missing jobId

    expect(onExportEvent).not.toHaveBeenCalled();
  });

  it("calls onCommandsChange with the parsed agent-commands payload ([E3.T3] #232/#236)", () => {
    let fake: FakeEventSource | undefined;
    const onCommandsChange = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onCommandsChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("agent-commands", {
      commands: [
        { name: "outline", description: "從大綱建立投影片", source: "bundled" },
        { name: "review", description: "", source: "agent" },
      ],
    });

    expect(onCommandsChange).toHaveBeenNthCalledWith(1, [
      { name: "outline", description: "從大綱建立投影片" },
      { name: "review", description: "" },
    ]);
  });

  it("drops a malformed agent-commands payload instead of fabricating a list ([E3.T3] #232/#236)", () => {
    let fake: FakeEventSource | undefined;
    const onCommandsChange = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onCommandsChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("agent-commands", { commands: [{ name: "outline" }] }); // missing description
    fake!.emit("agent-commands", { commands: "not-an-array" });
    fake!.emit("agent-commands", {}); // missing commands entirely

    expect(onCommandsChange).not.toHaveBeenCalled();
  });

  it("calls onAgentChanged with the parsed agent-changed payload ([E3.T5], NOOP-230 §4.4)", () => {
    let fake: FakeEventSource | undefined;
    const onAgentChanged = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onAgentChanged,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("agent-changed", { kind: "codex", label: "Codex" });

    expect(onAgentChanged).toHaveBeenNthCalledWith(1, { kind: "codex", label: "Codex" });
  });

  it("calls onAgentModelChanged with the parsed agent-model-changed payload, dropping malformed ones", () => {
    let fake: FakeEventSource | undefined;
    const onAgentModelChanged = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onAgentModelChanged,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("agent-model-changed", { kind: "codex", modelId: "gpt-5.5", name: "GPT-5.5" });
    fake!.emit("agent-model-changed", { kind: "gemini", modelId: "x", name: "X" });
    fake!.emit("agent-model-changed", { kind: "claude" });

    expect(onAgentModelChanged).toHaveBeenCalledTimes(1);
    expect(onAgentModelChanged).toHaveBeenNthCalledWith(1, { kind: "codex", modelId: "gpt-5.5", name: "GPT-5.5" });
  });

  it("drops a malformed agent-changed payload instead of fabricating a value ([E3.T5])", () => {
    let fake: FakeEventSource | undefined;
    const onAgentChanged = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onAgentChanged,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("agent-changed", { kind: "not-a-real-kind", label: "Codex" });
    fake!.emit("agent-changed", { kind: "codex" }); // missing label
    fake!.emit("agent-changed", {});

    expect(onAgentChanged).not.toHaveBeenCalled();
  });

  it("ignores events of a different type", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("some-other-event");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stop() closes the underlying EventSource", () => {
    let fake: FakeEventSource | undefined;
    liveReload = startLiveReload({
      onChange: () => {},
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    liveReload.stop();

    expect(fake?.closed).toBe(true);
  });

  it("does not call onChange for events received after stop()", () => {
    let fake: FakeEventSource | undefined;
    const onChange = vi.fn();
    liveReload = startLiveReload({
      onChange,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    liveReload.stop();
    fake!.emit("presentation-changed");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onError with the server's message when the watcher dies", () => {
    let fake: FakeEventSource | undefined;
    const onError = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onError,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("presentation-watch-error", { message: "監看簡報檔案時發生錯誤" });

    expect(onError).toHaveBeenCalledWith("監看簡報檔案時發生錯誤");
  });

  it("closes the connection once the watcher has died, instead of retrying against a server that will only ever refuse", () => {
    let fake: FakeEventSource | undefined;
    liveReload = startLiveReload({
      onChange: () => {},
      onError: () => {},
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    fake!.emit("presentation-watch-error", { message: "監看簡報檔案時發生錯誤" });

    expect(fake?.closed).toBe(true);
  });

  it("calls onError when the connection fails permanently (EventSource readyState CLOSED)", () => {
    let fake: FakeEventSource | undefined;
    const onError = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onError,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    (fake as unknown as { emitPermanentError: () => void }).emitPermanentError();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not call onError for an ordinary error while EventSource is still retrying", () => {
    let fake: FakeEventSource | undefined;
    const onError = vi.fn();
    liveReload = startLiveReload({
      onChange: () => {},
      onError,
      eventSourceFactory: (url) => {
        fake = new FakeEventSource(url) as unknown as EventSource;
        return fake as unknown as EventSource;
      },
    });

    // readyState stays CONNECTING (the fake's default) — this mirrors the
    // ordinary reconnect blip EventSource handles on its own.
    (fake as unknown as { emitError: () => void }).emitError();

    expect(onError).not.toHaveBeenCalled();
  });
});
