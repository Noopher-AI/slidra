// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { ServiceClients } from "./service-clients.js";
import { encodeCommandArgv } from "./command-argv.js";

export type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const AGENT_RUNNER_PREFIXES = ["/api/chat", "/api/agent", "/api/export"] as const;

function isAgentRunnerPath(path: string): boolean {
  return AGENT_RUNNER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function argvHeader(argv: string[]): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(argv))));
}

async function routeDeckWrite(
  clients: ServiceClients,
  path: string,
  init: RequestInit | undefined,
): Promise<Response> {
  if (path === "/api/asset") return clients.deck.fetch("/assets", init);
  if (path === "/api/undo" || path === "/api/redo") {
    const headers = new Headers(init?.headers);
    headers.set("x-slidra-argv", argvHeader([path.slice("/api/".length), clients.workbenchId ?? "", "--json"]));
    return clients.deck.fetch("/call", { ...init, headers, method: "POST" });
  }
  if (path === "/api/command") {
    let command: { name?: unknown; input?: unknown };
    try {
      command = JSON.parse(typeof init?.body === "string" ? init.body : "") as { name?: unknown; input?: unknown };
    } catch {
      return new Response(JSON.stringify({ error: "Request body is not valid JSON" }), { status: 400 });
    }
    if (typeof command.name !== "string" || command.name.length === 0) {
      return new Response(JSON.stringify({ error: "name must be a non-empty string" }), { status: 400 });
    }
    if (typeof command.input !== "object" || command.input === null || Array.isArray(command.input)) {
      return new Response(JSON.stringify({ error: "input must be an object" }), { status: 400 });
    }
    try {
      const encoded = await encodeCommandArgv(command.name, command.input as Record<string, unknown>);
      const headers = new Headers(init?.headers);
      headers.delete("content-type");
      headers.set("x-slidra-argv", argvHeader([...encoded.argv, "--json"]));
      const body = encoded.body === undefined ? undefined : new Uint8Array(encoded.body).buffer;
      return clients.deck.fetch("/call", { ...init, headers, body, method: "POST" });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : "Failed to encode command" }),
        { status: 400 },
      );
    }
  }
  return clients.deck.fetch(path, init);
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
    const path = input.split("?", 1)[0]!;
    if (["/api/command", "/api/asset", "/api/undo", "/api/redo"].includes(path)) {
      return routeDeckWrite(clients, path, init);
    }
    return isAgentRunnerPath(path)
      ? clients.agentRunner.fetch(input, init)
      : clients.deck.fetch(input, init);
  };
}
