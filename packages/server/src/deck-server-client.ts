// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { resolveSlidraBin } from "./slidra/bin.js";
import { SlidraError } from "./slidra/errors.js";

/**
 * The Node-side half of [E10.T5]'s transitional forwarding layer
 * (NOOP-641 Plan §7 decision 4: "薄轉發層是刻意過渡態"): `slidra serve`
 * spawns the crate's `slidra __deck-server` once, as a real subprocess
 * (AC1 is a property of the crate process itself, not of this Node
 * process, which never reads or writes a `.slidra` file directly — see
 * ADR-0002), and every route this ticket migrates forwards its request to
 * it instead of dispatching in Node. `deployAgentWorkdir`/`command-
 * endpoint.ts` already spawn the same binary per call; this differs only
 * in staying up for the server's whole lifetime instead of one call.
 *
 * A single shared `DeckServerClient` per `startServe()` call, closed by
 * the same `disposers` array every other server-lifetime resource uses.
 */

export interface DeckServerClient {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** How long to wait for the child's one-line `{"port":N}` startup message before giving up. */
const STARTUP_TIMEOUT_MS = 10_000;

export async function startDeckServer(): Promise<DeckServerClient> {
  const bin = resolveSlidraBin();
  const child = spawn(bin, ["__deck-server"], { stdio: ["ignore", "pipe", "inherit"] });

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new SlidraError("slidra __deck-server did not report a port in time"));
    }, STARTUP_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        const parsed = JSON.parse(line) as { port?: unknown };
        if (typeof parsed.port !== "number") throw new Error("no port field");
        cleanup();
        resolve(parsed.port);
      } catch {
        cleanup();
        reject(new SlidraError(`slidra __deck-server printed an unparseable startup line: ${line}`));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new SlidraError(`slidra __deck-server failed to start: ${error.message}`));
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new SlidraError(`slidra __deck-server exited before reporting a port (code ${code})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => closeChild(child),
  };
}

function closeChild(child: ChildProcessByStdio<null, Readable, null>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill();
  });
}

/** `x-slidra-credential`'s wire shape (`server/credential.rs`'s `encode`), built here rather than imported from the crate — this Node process has no dependency edge to it, same posture `allowlist.rs`'s own doc comment describes for the whitelist's hand-copy. */
function credentialHeader(kind: "editor" | "agent" | "viewer", workbenchId: string): string {
  return Buffer.from(JSON.stringify({ kind, workbenchId }), "utf8").toString("base64");
}

/** Hop-by-hop headers that must never be forwarded verbatim from the upstream response — Node's own `http` module manages framing/connection state itself. */
const HOP_BY_HOP = new Set(["connection", "transfer-encoding", "content-length", "keep-alive"]);

/**
 * Forwards a GET request to the deck server as the editor credential
 * (this Node process stands in for the not-yet-built launcher — credential
 * issuance is [S11.F6]/T9's job, out of this ticket's scope), streaming
 * the upstream response's status, headers (minus hop-by-hop ones) and body
 * back onto `res` as they arrive — the same code path serves both an
 * ordinary buffered JSON/raw response and `/events`' long-lived stream,
 * since both are just "keep copying chunks until the upstream body ends."
 */
export async function forwardDeckServerGet(
  client: DeckServerClient,
  path: string,
  workbenchId: string,
  res: ServerResponse,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const upstream = await fetch(`${client.baseUrl}${path}`, {
    headers: {
      "x-slidra-credential": credentialHeader("editor", workbenchId),
      ...extraHeaders,
    },
  });

  const headers: Record<string, string> = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } finally {
    res.end();
  }
}
