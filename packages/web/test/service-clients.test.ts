// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceClients, readBootstrap } from "../src/service-clients.js";

const bootstrap = {
  workbenchId: "wb-7",
  deck: {
    url: "http://127.0.0.1:4100",
    credential: "editor-secret",
  },
  agentRunner: {
    url: "http://127.0.0.1:4200",
    sessionToken: "runner-secret",
  },
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("service bootstrap", () => {
  it("reads the one-time bootstrap payload and removes it from the DOM", () => {
    const node = document.createElement("script");
    node.id = "slidra-bootstrap";
    node.type = "application/json";
    node.textContent = JSON.stringify(bootstrap);
    document.body.append(node);

    expect(readBootstrap(document)).toEqual(bootstrap);
    expect(document.getElementById("slidra-bootstrap")).toBeNull();
  });
});

describe("service clients", () => {
  it("sends deck and agent-runner calls to separate origins with separate credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const clients = createServiceClients(bootstrap, fetchImpl);

    await clients.deck.fetch("/api/presentation");
    await clients.agentRunner.fetch("/api/chat", { method: "POST" });

    const [deckUrl, deckInit] = fetchImpl.mock.calls[0]!;
    expect(deckUrl).toBe("http://127.0.0.1:4100/presentation");
    expect(new Headers(deckInit?.headers).get("x-slidra-credential")).toBe("editor-secret");
    expect(new Headers(deckInit?.headers).get("x-slidra-runner-session")).toBeNull();

    const [runnerUrl, runnerInit] = fetchImpl.mock.calls[1]!;
    expect(runnerUrl).toBe("http://127.0.0.1:4200/api/chat");
    expect(new Headers(runnerInit?.headers).get("x-slidra-runner-session")).toBe("runner-secret");
    expect(new Headers(runnerInit?.headers).get("x-slidra-credential")).toBeNull();
  });

  it("parses a credentialed SSE stream across chunk boundaries and can stop reconnecting", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const clients = createServiceClients(bootstrap, fetchImpl);
    const onEvent = vi.fn();

    const subscription = clients.deck.subscribe({ onEvent, reconnectMs: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.enqueue(encoder.encode("event: workbench-chan"));
    controller.enqueue(encoder.encode("ged\ndata: {\"source\":\"agent\"}\n\n"));
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        type: "workbench-changed",
        data: '{"source":"agent"}',
      }),
    );

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4100/events");
    expect(new Headers(init?.headers).get("x-slidra-credential")).toBe("editor-secret");
    subscription.stop();
    expect(init?.signal?.aborted).toBe(true);
    controller.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
