import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveReload } from "../src/live-reload.js";
import type { LiveReload } from "../src/live-reload.js";

// jsdom has no EventSource, so every test drives a fake constructor
// injected via `eventSourceFactory` rather than stubbing a global.

class FakeEventSource {
  url: string;
  closed = false;
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
});
