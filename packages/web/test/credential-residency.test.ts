// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceClients, readBootstrap } from "../src/service-clients.js";

afterEach(() => {
  document.body.replaceChildren();
  document.cookie = "slidra=; Max-Age=0";
  vi.restoreAllMocks();
});

describe("browser credential residency", () => {
  it("keeps both credentials in memory and request headers, never storage, cookies, or URLs", async () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const node = document.createElement("script");
    node.type = "application/json";
    node.id = "slidra-bootstrap";
    node.textContent = JSON.stringify({
      workbenchId: "wb-1",
      deck: { url: "http://deck.test", credential: "deck-secret" },
      agentRunner: { url: "http://runner.test", sessionToken: "runner-secret" },
    });
    document.body.append(node);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const clients = createServiceClients(readBootstrap(document), fetchImpl);

    await clients.deck.fetch("/api/presentation");
    await clients.agentRunner.fetch("/api/chat", { method: "POST" });

    expect(storageWrite).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain("deck-secret");
    expect(document.cookie).not.toContain("runner-secret");
    for (const [url] of fetchImpl.mock.calls) {
      expect(String(url)).not.toContain("deck-secret");
      expect(String(url)).not.toContain("runner-secret");
    }
  });
});
