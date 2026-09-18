// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { ServiceClients } from "./service-clients.js";

export type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const AGENT_RUNNER_PREFIXES = ["/api/chat", "/api/agent", "/api/export"] as const;

function isAgentRunnerPath(path: string): boolean {
  return AGENT_RUNNER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Routes only same-page `/api/*` calls. Absolute asset/font/network requests keep their native destination. */
export function createRoutingFetch(
  clients: ServiceClients,
  nativeFetch: BrowserFetch = globalThis.fetch.bind(globalThis),
): BrowserFetch {
  return (input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) {
      return nativeFetch(input, init);
    }
    return isAgentRunnerPath(input.split("?", 1)[0]!)
      ? clients.agentRunner.fetch(input, init)
      : clients.deck.fetch(input, init);
  };
}
