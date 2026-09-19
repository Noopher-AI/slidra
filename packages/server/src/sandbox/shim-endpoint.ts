// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * `POST /api/agent/exec` — the CLI sandbox's own entry point (NOOP-425 §0's
 * "second, reversed sandbox"). `<sandboxRoot>/bin/slidra` (the shim wrapper
 * on the agent's `PATH`, see `../../shim/slidra-shim.mjs`) is the only
 * caller: it forwards the agent's own `slidra <args>` invocation here as an
 * HTTP request, this endpoint runs the real `slidra` binary wrapped in
 * `buildCliSandboxPolicy()` (never the agent's own write policy — that is
 * the whole point of having two sandboxes), and streams the real process's
 * stdout/stderr/exit code back byte-for-byte.
 *
 * The framing is deliberately raw, not JSON and not line-delimited: a
 * `slidra` command can return binary asset bytes or >1 MB of output (AC5),
 * and JSON-encoding either would mean decoding and re-encoding bytes that
 * must survive unchanged. Each frame is `[1 byte kind][4 bytes length,
 * big-endian][payload]`; kind 1 is stdout, 2 is stderr, 3 is exit (the
 * 4-byte payload is a signed big-endian exit code, and ends the stream).
 * `res.flushHeaders()` is called immediately, before the child even starts,
 * and every chunk is written to the response as it arrives — never buffered
 * until the process ends.
 */
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { postDeckServerCall, type DeckServerClient } from "../deck-server-client.js";

const TOKEN_HEADER = "x-slidra-shim-token";
const ARGV_HEADER = "x-slidra-shim-argv";
const CWD_HEADER = "x-slidra-shim-cwd";

const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;

const UNAUTHORIZED_MESSAGE = "unauthorized";

export interface ShimExecOptions {
  /** This server's own sandbox root — every accepted `cwd` must resolve inside it. */
  sandboxRoot: string;
  /** Per-serve shared secret (`sandbox/shim-token.ts`); compared in constant time. */
  token: string;
  /** The currently bound deck's id, or null when none is bound. */
  currentDeckId(): string | null;
  deckServer: DeckServerClient;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Constant-time comparison over equal-length buffers — a length mismatch alone is not a timing oracle for a fixed-length random token. */
function tokensMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function sendPlainText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

/** Parses the argv header: must decode to a JSON array of one or more strings. Never repairs or drops a bad element — any failure is the whole request's failure. */
function parseArgvHeader(value: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Utf8(value));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return parsed;
}

/** One directory, two spellings when a symlink is in the path (macOS
 *  `/var/folders/…` vs `/private/var/folders/…`). An unresolvable path falls
 *  back to its own spelling — never to "accept". */
function canonical(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
}

/** Resolves the `cwd` header against `sandboxRoot`; undefined means "reject", distinct from "header absent" (the caller's own default). */
function resolveRequestedCwd(sandboxRoot: string, header: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeBase64Utf8(header);
  } catch {
    return undefined;
  }
  const resolved = canonical(path.resolve(decoded));
  const relative = path.relative(canonical(sandboxRoot), resolved);
  if (relative === "") return resolved;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function writeFrame(res: ServerResponse, kind: number, payload: Buffer): void {
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(payload.length, 1);
  res.write(Buffer.concat([header, payload]));
}

function writeExitFrame(res: ServerResponse, exitCode: number): void {
  const header = Buffer.alloc(5);
  header.writeUInt8(FRAME_EXIT, 0);
  header.writeInt32BE(exitCode, 1);
  res.end(header);
}

export function handleShimExec(req: IncomingMessage, res: ServerResponse, options: ShimExecOptions): void {
  const token = headerValue(req, TOKEN_HEADER);
  if (token === undefined || !tokensMatch(options.token, token)) {
    // Same text, same status for "missing" and "wrong" — a distinguishable
    // response would tell a caller when it has found a real token to guess
    // against.
    sendPlainText(res, 401, UNAUTHORIZED_MESSAGE);
    return;
  }

  const argvHeader = headerValue(req, ARGV_HEADER);
  const argv = argvHeader === undefined ? undefined : parseArgvHeader(argvHeader);
  if (argv === undefined) {
    sendPlainText(res, 400, "missing or invalid argv header");
    return;
  }

  const currentId = options.currentDeckId();
  if (currentId === null) {
    sendJson(res, 409, { reason: "no-deck" });
    return;
  }

  const cwdHeader = headerValue(req, CWD_HEADER);
  const cwd = cwdHeader === undefined ? path.join(options.sandboxRoot, currentId) : resolveRequestedCwd(options.sandboxRoot, cwdHeader);
  if (cwd === undefined) {
    sendPlainText(res, 400, "cwd must resolve inside this server's sandbox root");
    return;
  }

  void runShimCommand(req, res, argv, currentId, options.deckServer);
}

async function runShimCommand(req: IncomingMessage, res: ServerResponse, argv: string[], deckId: string, deckServer: DeckServerClient): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const outcome = await postDeckServerCall(deckServer, argv, deckId, "agent", Buffer.concat(chunks));
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.flushHeaders();
  if (!outcome.ok) {
    writeFrame(res, FRAME_STDERR, Buffer.from(outcome.doorError, "utf8"));
    writeExitFrame(res, 1);
    return;
  }
  if (outcome.stdout.length > 0) writeFrame(res, FRAME_STDOUT, outcome.stdout);
  if (outcome.stderr.length > 0) writeFrame(res, FRAME_STDERR, outcome.stderr);
  writeExitFrame(res, outcome.exitCode);
}
