// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { ServiceClients } from "./service-clients.js";
import { COMMAND_WHITELIST, encodeCommandArgv } from "./command-argv.js";

export type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const AGENT_RUNNER_PREFIXES = ["/api/chat", "/api/agent", "/api/export"] as const;

function isAgentRunnerPath(path: string): boolean {
  return AGENT_RUNNER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function argvHeader(argv: string[]): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(argv))));
}

function callResult(response: Response): Promise<Response> {
  if (!response.ok) {
    return response.text().then((error) => new Response(
      JSON.stringify({ error: error || "Deck server refused the command" }),
      { status: response.status, headers: { "content-type": "application/json" } },
    ));
  }
  return response.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let exitCode = 0;
    for (let offset = 0; offset < bytes.length;) {
      const kind = bytes[offset]!;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4);
      const value = view.getUint32(0, false);
      offset += 5;
      if (kind === 3) {
        exitCode = value | 0;
        break;
      }
      const payload = bytes.slice(offset, offset + value);
      offset += value;
      if (kind === 1) stdout.push(payload);
      if (kind === 2) stderr.push(payload);
    }
    const output = new TextDecoder().decode(concatBytes(stdout));
    const errorOutput = new TextDecoder().decode(concatBytes(stderr));
    let envelope: { ok?: boolean; message?: string; failureKind?: string | null } | undefined;
    try {
      envelope = JSON.parse(output) as typeof envelope;
    } catch {
      return new Response(JSON.stringify({ error: errorOutput || "Command returned invalid JSON" }), { status: 500 });
    }
    if (exitCode !== 0 || envelope?.ok === false) {
      return new Response(
        JSON.stringify({ error: envelope?.message || errorOutput || "Command failed", failureKind: envelope?.failureKind ?? null }),
        { status: envelope?.failureKind === "not-found" ? 404 : 500, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(output, { status: 200, headers: { "content-type": "application/json" } });
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
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
    return clients.deck.fetch("/call", { ...init, headers, method: "POST" }).then(callResult);
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
    if (!COMMAND_WHITELIST.includes(command.name)) {
      return new Response(JSON.stringify({ error: `This endpoint does not accept command: ${command.name}` }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
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
      return clients.deck.fetch("/call", { ...init, headers, body, method: "POST" }).then(callResult);
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
