// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it, vi } from "vitest";
import { createServiceClients } from "../src/service-clients.js";
import { createRoutingFetch } from "../src/service-routing.js";

function framedEnvelope(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(5 + payload.length + 5);
  bytes[0] = 1;
  new DataView(bytes.buffer).setUint32(1, payload.length, false);
  bytes.set(payload, 5);
  bytes[5 + payload.length] = 3;
  new DataView(bytes.buffer).setUint32(6 + payload.length, 0, false);
  return bytes;
}

describe("browser API routing", () => {
  it("routes deck and agent-runner APIs through their dedicated clients", async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const clients = createServiceClients(
      {
        workbenchId: "wb-9",
        deck: { url: "http://deck.test:4100", credential: "deck-token" },
        agentRunner: { url: "http://runner.test:4200", sessionToken: "runner-token" },
      },
      nativeFetch,
    );
    const routedFetch = createRoutingFetch(clients, nativeFetch);

    await routedFetch("/api/presentation");
    await routedFetch("/api/chat", { method: "POST" });
    await routedFetch("/api/agent/model", { method: "POST" });
    await routedFetch("/api/export", { method: "POST" });
    await routedFetch("https://cdn.example/font.woff2");

    expect(nativeFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://deck.test:4100/presentation",
      "http://runner.test:4200/api/chat",
      "http://runner.test:4200/api/agent/model",
      "http://runner.test:4200/api/export",
      "https://cdn.example/font.woff2",
    ]);
  });

  it("maps editor write affordances onto the crate's actual command and asset routes", async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const clients = createServiceClients(
      {
        workbenchId: "wb-9",
        deck: { url: "http://deck.test:4100", credential: "deck-token" },
        agentRunner: { url: "http://runner.test:4200", sessionToken: "runner-token" },
      },
      nativeFetch,
    );
    const routedFetch = createRoutingFetch(clients, nativeFetch);

    await routedFetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "slide add", input: { id: "browser-supplied-id" } }),
    });
    await routedFetch("/api/asset", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    await routedFetch("/api/undo", { method: "POST" });
    await routedFetch("/api/redo", { method: "POST" });

    expect(nativeFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://deck.test:4100/call",
      "http://deck.test:4100/assets",
      "http://deck.test:4100/call",
      "http://deck.test:4100/call",
    ]);
    for (const index of [0, 2, 3]) {
      expect(new Headers(nativeFetch.mock.calls[index]![1]?.headers).get("x-slidra-argv")).toBeTruthy();
    }
  });

  it("preserves an internal command failure as 500 instead of misclassifying it as a client error", async () => {
    const nativeFetch = vi.fn(async () => new Response(framedEnvelope({
      ok: false,
      message: "the command failed after validation",
      failureKind: "failed",
    }), { status: 200 }));
    const clients = createServiceClients(
      {
        workbenchId: "wb-9",
        deck: { url: "http://deck.test:4100", credential: "deck-token" },
        agentRunner: { url: "http://runner.test:4200", sessionToken: "runner-token" },
      },
      nativeFetch,
    );

    const response = await createRoutingFetch(clients, nativeFetch)("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "slide add", input: { id: "browser-supplied-id" } }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "the command failed after validation",
      failureKind: "failed",
    });
  });

  it("rejects malformed command requests before dispatching them", async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const clients = createServiceClients(
      {
        workbenchId: "wb-9",
        deck: { url: "http://deck.test:4100", credential: "deck-token" },
        agentRunner: { url: "http://runner.test:4200", sessionToken: "runner-token" },
      },
      nativeFetch,
    );
    const routedFetch = createRoutingFetch(clients, nativeFetch);
    const requests = [
      { label: "malformed JSON", body: "{ not json" },
      { label: "non-object input", body: JSON.stringify({ name: "element move", input: 42 }) },
      { label: "non-string name", body: JSON.stringify({ name: 123, input: {} }) },
      { label: "missing name", body: JSON.stringify({ input: {} }) },
    ];

    for (const request of requests) {
      const response = await routedFetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request.body,
      });
      expect(response.status, request.label).toBe(400);
    }
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("preserves a not-found command failure as 404", async () => {
    const nativeFetch = vi.fn(async () => new Response(framedEnvelope({
      ok: false,
      message: "slide not found",
      failureKind: "not-found",
    }), { status: 200 }));
    const clients = createServiceClients(
      {
        workbenchId: "wb-9",
        deck: { url: "http://deck.test:4100", credential: "deck-token" },
        agentRunner: { url: "http://runner.test:4200", sessionToken: "runner-token" },
      },
      nativeFetch,
    );

    const response = await createRoutingFetch(clients, nativeFetch)("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "element move",
        input: { slidePath: "slides/999.svg", elementIds: ["el-a"], dx: 1, dy: 1 },
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "slide not found", failureKind: "not-found" });
  });

  it("preserves an empty undo stack as a 400 client error", async () => {
    const nativeFetch = vi.fn(async () => new Response(framedEnvelope({
      ok: false,
      message: "no operation to undo",
      failureKind: "failed",
    }), { status: 200 }));
    const clients = createServiceClients(
      {
        workbenchId: "wb-9",
        deck: { url: "http://deck.test:4100", credential: "deck-token" },
        agentRunner: { url: "http://runner.test:4200", sessionToken: "runner-token" },
      },
      nativeFetch,
    );

    const response = await createRoutingFetch(clients, nativeFetch)("/api/undo", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no operation to undo", failureKind: "failed" });
  });
});
