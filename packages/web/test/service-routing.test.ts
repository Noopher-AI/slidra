// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it, vi } from "vitest";
import { createServiceClients } from "../src/service-clients.js";
import { createRoutingFetch } from "../src/service-routing.js";

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
});
