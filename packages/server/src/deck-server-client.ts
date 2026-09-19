// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { ServerResponse } from "node:http";
import { resolveSlidraBin } from "./slidra/bin.js";
import { SlidraError } from "./slidra/errors.js";
import type { FileEntryPolicy } from "./policy/types.js";

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
  readonly initialWorkbenchId: string | null;
  close(): Promise<void>;
}

/** How long to wait for the child's one-line `{"port":N}` startup message before giving up. */
const STARTUP_TIMEOUT_MS = 10_000;

export async function startDeckServer(
  options: {
    editorOrigin?: string;
    fileEntry: Pick<FileEntryPolicy, "uploadBytes" | "remoteUrl">;
    initialDeckPath?: string;
  },
): Promise<DeckServerClient> {
  const bin = resolveSlidraBin();
  const args = ["__deck-server"];
  if (options.editorOrigin !== undefined) args.push("--editor-origin", options.editorOrigin);
  args.push("--asset-upload-bytes", String(options.fileEntry.uploadBytes));
  args.push("--asset-remote-url", String(options.fileEntry.remoteUrl));
  if (options.initialDeckPath !== undefined) args.push("--initial-deck", options.initialDeckPath);
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"] });

  const startup = await new Promise<{ port: number; workbenchId: string | null }>((resolve, reject) => {
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
        const parsed = JSON.parse(line) as { port?: unknown; workbenchId?: unknown };
        if (typeof parsed.port !== "number") throw new Error("no port field");
        if (parsed.workbenchId !== undefined && parsed.workbenchId !== null && typeof parsed.workbenchId !== "string") {
          throw new Error("invalid workbenchId field");
        }
        cleanup();
        resolve({ port: parsed.port, workbenchId: parsed.workbenchId ?? null });
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
    baseUrl: `http://127.0.0.1:${startup.port}`,
    initialWorkbenchId: startup.workbenchId,
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

export type CredentialKind = "editor" | "agent" | "viewer";

/** `x-slidra-credential`'s wire shape (`server/credential.rs`'s `encode`), built here rather than imported from the crate — this Node process has no dependency edge to it, same posture `allowlist.rs`'s own doc comment describes for the whitelist's hand-copy. */
function credentialHeader(kind: CredentialKind, workbenchId: string): string {
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
  await pipeUpstreamToResponse(upstream, res);
}

/** A credentialled GET whose JSON body is consumed by the Node runner. */
export async function getDeckServerJson(
  client: DeckServerClient,
  path: string,
  workbenchId: string,
  kind: CredentialKind,
): Promise<{ status: number; body: unknown }> {
  const upstream = await fetch(`${client.baseUrl}${path}`, {
    headers: { "x-slidra-credential": credentialHeader(kind, workbenchId) },
  });
  const text = await upstream.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: upstream.status, body };
}

async function pipeUpstreamToResponse(upstream: Response, res: ServerResponse): Promise<void> {
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
  // Couple both ends: a browser disconnect cancels the upstream body, and
  // an upstream failure destroys the response instead of ending truncated
  // content as though it were complete. pipeline also applies backpressure.
  await pipeline(Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>), res);
}

/**
 * A POST to the deck server whose JSON response Node itself needs to read
 * (rather than relay verbatim) — used by the editing-lock routes, which
 * apply the crate's decision to Node's own `EditingLock` object afterward
 * ("crate decides first, Node applies": see `serve.ts`'s editing routes).
 */
export async function postDeckServerJson(
  client: DeckServerClient,
  path: string,
  workbenchId: string,
  kind: CredentialKind,
  options?: { body?: Buffer; extraHeaders?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  const upstream = await fetch(`${client.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "x-slidra-credential": credentialHeader(kind, workbenchId),
      ...options?.extraHeaders,
    },
    body: options?.body === undefined ? undefined : new Uint8Array(options.body),
  });
  const text = await upstream.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: upstream.status, body };
}

const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;

/**
 * `server/mod.rs`'s `write_frame_response` frame shape, decoded: `[1 byte
 * kind][4 bytes big-endian length/value][payload]`, repeated until the
 * body ends. `kind===FRAME_EXIT`'s "payload" is the 4-byte value itself
 * (a big-endian signed exit code), not a length prefix for more bytes.
 */
function decodeCallFrames(bytes: Uint8Array): { stdout: Buffer; stderr: Buffer; exitCode: number } {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const kind = bytes[offset];
    const value = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    offset += 5;
    if (kind === FRAME_EXIT) {
      exitCode = value | 0; // reinterpret the same 32 bits as signed
      break;
    }
    const payload = Buffer.from(bytes.subarray(offset, offset + value));
    offset += value;
    if (kind === FRAME_STDOUT) stdoutChunks.push(payload);
    else if (kind === FRAME_STDERR) stderrChunks.push(payload);
  }
  return { stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), exitCode };
}

export type CallOutcome =
  | { ok: true; stdout: Buffer; stderr: Buffer; exitCode: number }
  | { ok: false; doorStatus: number; doorError: string };

/**
 * `POST /call` — the argv-based command door, for `/api/command`'s
 * forward ([E10.T5] Slice B). `argv` must already include `--json` (this
 * function does not append it — callers that want text output, if any
 * ever exist, must be able to omit it). A non-200 door status (401/403/
 * 400/409 — credential, allow-list, argv-shape, or editing-lock refusals)
 * is a DOOR-level refusal, never mistaken for command output: the body on
 * that path is plain text, not the frame protocol, so it is surfaced as
 * `doorError` instead of being fed to a frame decoder that would garbage
 * it.
 */
export async function postDeckServerCall(
  client: DeckServerClient,
  argv: string[],
  workbenchId: string,
  kind: CredentialKind,
  body?: string | Buffer,
): Promise<CallOutcome> {
  const argvHeader = Buffer.from(JSON.stringify(argv), "utf8").toString("base64");
  const upstream = await fetch(`${client.baseUrl}/call`, {
    method: "POST",
    headers: {
      "x-slidra-credential": credentialHeader(kind, workbenchId),
      "x-slidra-argv": argvHeader,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : new Uint8Array(body),
  });
  if (upstream.status !== 200) {
    const doorError = await upstream.text();
    return { ok: false, doorStatus: upstream.status, doorError };
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const { stdout, stderr, exitCode } = decodeCallFrames(bytes);
  return { ok: true, stdout, stderr, exitCode };
}
