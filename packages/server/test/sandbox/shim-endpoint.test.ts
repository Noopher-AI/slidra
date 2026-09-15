// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-425/NOOP-463 §4's behavior-contract table, and AC5 (byte-for-byte
 * identical stdout/stderr/exit code) — driven over real HTTP against a real
 * `handleShimExec`, with a small real executable standing in for `slidra`
 * (never a mock of the handler itself). `SLIDRA_SANDBOX=off` throughout:
 * this file is about the shim's own HTTP/framing contract, not OS
 * enforcement (`os-enforcement.test.ts` owns that).
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleShimExec } from "../../src/sandbox/shim-endpoint.js";
import { resolveShimScriptPath } from "../../src/sandbox/shim-wrapper.js";
import { writeProjectsRegistry } from "../../src/slidra/home.js";

const execFileAsync = promisify(execFile);

const TOKEN = "test-shim-token";
const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;
const FRAME_HEADER_BYTES = 5;

/** A minimal, real executable standing in for `slidra`: `argv[0]` picks a canned behavior, everything after is echoed into it where relevant. */
const FAKE_BIN_SOURCE = `#!/usr/bin/env node
const mode = process.argv[2];
if (mode === "large") {
  process.stdout.write(Buffer.alloc(1_500_000, 0x61));
} else if (mode === "binary") {
  process.stdout.write(Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80, 0x81, 10, 0]));
} else if (mode === "stderr-and-fail") {
  process.stderr.write("stub failure\\n");
  process.exit(7);
} else if (mode === "echo-stdin") {
  process.stdin.pipe(process.stdout);
} else {
  process.stdout.write("stub stdout\\n");
}
`;

interface Frame {
  kind: number;
  payload: Buffer;
}

function parseAllFrames(buf: Buffer): Frame[] {
  const frames: Frame[] = [];
  let offset = 0;
  for (;;) {
    if (offset + FRAME_HEADER_BYTES > buf.length) break;
    const kind = buf.readUInt8(offset);
    if (kind === FRAME_EXIT) {
      frames.push({ kind, payload: buf.subarray(offset + 1, offset + FRAME_HEADER_BYTES) });
      offset += FRAME_HEADER_BYTES;
      continue;
    }
    const length = buf.readUInt32BE(offset + 1);
    const payload = buf.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length);
    frames.push({ kind, payload });
    offset += FRAME_HEADER_BYTES + length;
  }
  return frames;
}

function concatKind(frames: Frame[], kind: number): Buffer {
  return Buffer.concat(frames.filter((f) => f.kind === kind).map((f) => f.payload));
}

function exitCodeOf(frames: Frame[]): number {
  const exitFrame = frames.find((f) => f.kind === FRAME_EXIT);
  if (!exitFrame) throw new Error("no exit frame in response");
  return exitFrame.payload.readInt32BE(0);
}

let server: Server;
let baseUrl: string;
let sandboxRoot: string;
let slidraHome: string;
let fakeBinPath: string;
let currentDeckId: string | null;

beforeEach(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), "shim-endpoint-root-"));
  slidraHome = await mkdtemp(path.join(tmpdir(), "shim-endpoint-home-"));
  process.env.SLIDRA_HOME = slidraHome;

  fakeBinPath = path.join(sandboxRoot, "fake-slidra.mjs");
  await writeFile(fakeBinPath, FAKE_BIN_SOURCE);
  await chmod(fakeBinPath, 0o755);
  process.env.SLIDRA_BIN = fakeBinPath;
  process.env.SLIDRA_SANDBOX = "off";

  currentDeckId = "pres-1";
  await writeProjectsRegistry(new Map([["pres-1", { deckPath: path.join(sandboxRoot, "deck.slidra") }]]));
  // The default cwd (no cwd header) is `<sandboxRoot>/<currentId>` — real
  // `serve.ts` always has this because `deployAgentWorkdir` created it;
  // here it must exist too, or `spawn()`'s own cwd lookup fails before the
  // command ever runs.
  await mkdir(path.join(sandboxRoot, currentDeckId), { recursive: true });

  server = http.createServer((req, res) => {
    if (req.url === "/api/agent/exec") {
      handleShimExec(req, res, {
        sandboxRoot,
        token: TOKEN,
        currentDeckId: () => currentDeckId,
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  delete process.env.SLIDRA_SANDBOX;
  await rm(sandboxRoot, { recursive: true, force: true });
  await rm(slidraHome, { recursive: true, force: true });
});

/** Sends one `POST /api/agent/exec` request and resolves with the raw HTTP status/body, or the parsed frames for a 200. */
async function callShim(options: {
  token?: string;
  argv?: string[];
  cwd?: string;
  omitArgvHeader?: boolean;
  body?: string;
  /** Defaults to the shared server; only the symlinked-root test below points elsewhere. */
  target?: string;
}): Promise<{ status: number; frames: Frame[] | null; rawBody: string }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers["x-slidra-shim-token"] = options.token;
  if (!options.omitArgvHeader) {
    headers["x-slidra-shim-argv"] = Buffer.from(JSON.stringify(options.argv ?? []), "utf8").toString("base64");
  }
  if (options.cwd !== undefined) {
    headers["x-slidra-shim-cwd"] = Buffer.from(options.cwd, "utf8").toString("base64");
  }

  return new Promise((resolve, reject) => {
    const req = http.request(`${options.target ?? baseUrl}/api/agent/exec`, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          frames: res.statusCode === 200 ? parseAllFrames(raw) : null,
          rawBody: raw.toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end(options.body ?? "");
  });
}

describe("POST /api/agent/exec — behavior contract", () => {
  it("401s with identical text for a missing token and a wrong token", async () => {
    const missing = await callShim({ argv: ["x"] });
    const wrong = await callShim({ token: "not-the-token", argv: ["x"] });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.rawBody).toBe(wrong.rawBody);
  });

  it("400s on a missing argv header, never substituting a default command", async () => {
    const result = await callShim({ token: TOKEN, omitArgvHeader: true });
    expect(result.status).toBe(400);
  });

  it("400s on an empty argv array, never substituting a default command", async () => {
    const result = await callShim({ token: TOKEN, argv: [] });
    expect(result.status).toBe(400);
  });

  it("400s on a malformed (non-base64/JSON/string-array) argv header", async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/agent/exec`,
        { method: "POST", headers: { "x-slidra-shim-token": TOKEN, "x-slidra-shim-argv": "not valid base64 json!!" } },
        (res) => resolve({ status: res.statusCode ?? 0 }),
      );
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(400);
  });

  it("400s on a cwd outside the sandbox root, never silently substituting the server's own cwd", async () => {
    const result = await callShim({ token: TOKEN, argv: ["x"], cwd: "/etc" });
    expect(result.status).toBe(400);
  });

  it("defaults cwd to <sandboxRoot>/<currentId> when the cwd header is absent", async () => {
    const result = await callShim({ token: TOKEN, argv: ["echo-stdin"] });
    // A successful 200 (not a 400) proves the default was accepted as a legal cwd.
    expect(result.status).toBe(200);
  });

  it("409s with {reason: 'no-deck'} when no deck is bound", async () => {
    currentDeckId = null;
    const result = await callShim({ token: TOKEN, argv: ["x"] });
    expect(result.status).toBe(409);
    expect(JSON.parse(result.rawBody)).toEqual({ reason: "no-deck" });
  });

  it("AC5: normal stdout/exit code are byte-identical to running the same command directly", async () => {
    const direct = await execFileAsync(fakeBinPath, ["default"]);
    const viaShim = await callShim({ token: TOKEN, argv: ["default"] });
    expect(viaShim.status).toBe(200);
    const frames = viaShim.frames!;
    expect(concatKind(frames, FRAME_STDOUT).toString("utf8")).toBe(direct.stdout);
    expect(exitCodeOf(frames)).toBe(0);
  });

  it("AC5: output exceeding 1 MB arrives byte-for-byte, uncapped by execFile's own maxBuffer default", async () => {
    const direct = await execFileAsync(fakeBinPath, ["large"], { maxBuffer: 2_000_000 });
    const viaShim = await callShim({ token: TOKEN, argv: ["large"] });
    expect(viaShim.status).toBe(200);
    const frames = viaShim.frames!;
    const stdout = concatKind(frames, FRAME_STDOUT);
    expect(stdout.length).toBe(1_500_000);
    expect(stdout.equals(Buffer.from(direct.stdout, "utf8"))).toBe(true);
    expect(exitCodeOf(frames)).toBe(0);
  });

  it("AC5: binary (non-UTF-8) output arrives byte-for-byte, never passed through text decoding", async () => {
    const direct = await execFileAsync(fakeBinPath, ["binary"], { encoding: "buffer" as BufferEncoding });
    const viaShim = await callShim({ token: TOKEN, argv: ["binary"] });
    expect(viaShim.status).toBe(200);
    const frames = viaShim.frames!;
    const stdout = concatKind(frames, FRAME_STDOUT);
    expect(stdout.equals(direct.stdout as unknown as Buffer)).toBe(true);
  });

  it("a real non-zero exit and real stderr are relayed unwrapped, not translated into an HTTP error", async () => {
    const viaShim = await callShim({ token: TOKEN, argv: ["stderr-and-fail"] });
    expect(viaShim.status).toBe(200); // the transport succeeded; the *command* failed
    const frames = viaShim.frames!;
    expect(concatKind(frames, FRAME_STDERR).toString("utf8")).toBe("stub failure\n");
    expect(exitCodeOf(frames)).toBe(7);
  });

  /**
   * The three AC5 tests above stop at the endpoint's own response frames.
   * This one runs the other half — the real `shim/slidra-shim.mjs` client
   * the agent's shell actually invokes (`<sandboxRoot>/bin/slidra`) — with
   * its stdout on a pipe, which is what every caller that captures a
   * command's output gives it (`sh -c "slidra cat ... "` inside the fake
   * ACP fixture, `$(slidra ...)`, a real agent's own command runner). A
   * `slidra cat <id> slides/001.svg` of a real slide clears 64 KB easily,
   * and AC5 names >1 MB explicitly.
   */
  it("AC5: the real shim client relays >1 MB to a piped stdout byte-for-byte", async () => {
    const shimScript = resolveShimScriptPath();
    const direct = await execFileAsync(fakeBinPath, ["large"], { encoding: "buffer" as BufferEncoding, maxBuffer: 4_000_000 });

    const { stdout, stderr, code } = await new Promise<{ stdout: Buffer; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [shimScript, "large"], {
        // The agent's shell always runs inside its own deployed work
        // directory; the endpoint rejects any cwd outside the sandbox root.
        cwd: path.join(sandboxRoot, "pres-1"),
        env: { ...process.env, SLIDRA_SHIM_TOKEN: TOKEN, SLIDRA_SHIM_BASE_URL: baseUrl },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let errText = "";
      // A consumer that is not draining the pipe the instant bytes appear —
      // `slidra cat … | head`, a shell pipeline, or simply an agent whose
      // event loop is busy. Everything the command wrote must still arrive:
      // a pipe holds ~64 KB, so anything larger depends on the writer
      // staying alive until the reader has taken it.
      child.stdout.pause();
      setTimeout(() => {
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stdout.resume();
      }, 300);
      child.stderr.on("data", (chunk: Buffer) => (errText += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ stdout: Buffer.concat(chunks), stderr: errText, code: exitCode }));
      child.stdin.end();
    });

    // Reported together: a short read with exit 0 and an empty stderr is
    // the failure mode that matters here — output lost with nothing at all
    // to tell the caller it happened.
    expect({ bytes: stdout.length, stderr, code }).toEqual({
      bytes: (direct.stdout as unknown as Buffer).length,
      stderr: "",
      code: 0,
    });
    expect(stdout.equals(direct.stdout as unknown as Buffer)).toBe(true);
  });

  /**
   * NOOP-474 (Review): macOS's `os.tmpdir()` is `/var/folders/…`, a path that
   * only exists through the `/var → /private/var` symlink, while a child
   * process's own `process.cwd()` — exactly what `slidra-shim.mjs` sends in
   * the cwd header — is always the resolved `/private/var/folders/…`.
   * `resolveRequestedCwd` compares the two as strings, so on macOS every shim
   * call is refused with 400. Reproduced here on any platform by giving the
   * server a symlink to the same root the caller names by its real path.
   */
  it("accepts a cwd that reaches the sandbox root through a symlink (the macOS /var -> /private/var case)", async () => {
    const linkDir = await mkdtemp(path.join(tmpdir(), "shim-endpoint-link-"));
    const linkedRoot = path.join(linkDir, "root");
    await symlink(sandboxRoot, linkedRoot);

    const linkedServer = http.createServer((req, res) => {
      handleShimExec(req, res, { sandboxRoot: linkedRoot, token: TOKEN, currentDeckId: () => currentDeckId });
    });
    await new Promise<void>((resolve) => linkedServer.listen(0, "127.0.0.1", resolve));
    const linkedUrl = `http://127.0.0.1:${String((linkedServer.address() as AddressInfo).port)}`;

    try {
      const result = await callShim({
        token: TOKEN,
        argv: ["stub"],
        // The real, symlink-free path of the very directory `linkedRoot`
        // points at — the same physical directory, spelled the way a spawned
        // child process reports it.
        cwd: path.join(sandboxRoot, "pres-1"),
        target: linkedUrl,
      });
      expect(result.status).toBe(200);
    } finally {
      linkedServer.closeAllConnections();
      await new Promise<void>((resolve) => linkedServer.close(() => resolve()));
      await rm(linkDir, { recursive: true, force: true });
    }
  });

  /**
   * The symlink-resolution fix above must not widen the accepted set: a cwd
   * that is nominally inside `sandboxRoot` but is itself a symlink pointing
   * outside it (e.g. `/etc`) still has to be rejected. Before the fix this
   * passed — the raw string comparison saw `<sandboxRoot>/escape` and
   * treated it as "inside" without ever resolving where it actually leads.
   */
  it("400s on a cwd inside the sandbox root that is a symlink pointing outside it", async () => {
    const escapeLink = path.join(sandboxRoot, "escape");
    await symlink("/etc", escapeLink);
    try {
      const result = await callShim({ token: TOKEN, argv: ["x"], cwd: escapeLink });
      expect(result.status).toBe(400);
    } finally {
      await rm(escapeLink, { force: true });
    }
  });

  it("forwards the request body to the command's stdin", async () => {
    const viaShim = await callShim({ token: TOKEN, argv: ["echo-stdin"], body: "hello from stdin" });
    expect(viaShim.status).toBe(200);
    const frames = viaShim.frames!;
    expect(concatKind(frames, FRAME_STDOUT).toString("utf8")).toBe("hello from stdin");
    expect(exitCodeOf(frames)).toBe(0);
  });
});
