// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, describe, expect, it, vi } from "vitest";
import { getServiceClients, startServiceRuntime } from "../src/service-runtime.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("editor service runtime", () => {
  it("consumes bootstrap before the app starts and installs routing for the page lifetime", async () => {
    const bootstrap = document.createElement("script");
    bootstrap.id = "slidra-bootstrap";
    bootstrap.type = "application/json";
    bootstrap.textContent = JSON.stringify({
      workbenchId: "wb-runtime",
      deck: { url: "http://deck.test", credential: "deck-secret" },
      agentRunner: { url: "http://runner.test", sessionToken: "runner-secret" },
    });
    document.body.append(bootstrap);
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const host = { fetch: nativeFetch as typeof globalThis.fetch };

    const runtime = startServiceRuntime(document, host);
    await host.fetch("/api/presentation");

    expect(document.getElementById("slidra-bootstrap")).toBeNull();
    expect(getServiceClients()).toBe(runtime.clients);
    expect(nativeFetch.mock.calls[0]?.[0]).toBe("http://deck.test/presentation");

    runtime.stop();
    expect(host.fetch).toBe(nativeFetch);
  });
});
