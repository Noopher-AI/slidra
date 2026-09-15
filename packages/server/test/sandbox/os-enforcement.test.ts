// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-425 AC1/AC2/AC3/AC4: real sandbox enforcement, not a mock. Every
 * test here builds a real `SandboxLauncher` (`createLandlockLauncher()` on
 * Linux, skipped everywhere else — this project has no macOS pod to run
 * `createSrtLauncher()`'s Seatbelt path against) and actually spawns a real
 * child process through it. "Tested on the `SandboxLauncher` interface"
 * (NOOP-463 plan §6): never on `slidra-sandbox-exec`'s argv shape.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLandlockLauncher } from "../../src/sandbox/landlock-launcher.js";
import { buildAgentSandboxPolicy } from "../../src/sandbox/policy.js";
import { touchesProtectedPath, type ProtectedPaths } from "../../src/agent/protected-paths.js";
import type { SandboxLauncher } from "../../src/sandbox/launcher.js";

const isLinux = process.platform === "linux";

// Same real binary `crates/slidra`'s own `[[bin]]` target produces
// (`npm run build` runs `cargo build --release` first) — these tests exist
// to prove the real helper restricts a real process, not a fixture.
const helperPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../target/release/slidra-sandbox-exec",
);

const cleanupDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * A scratch directory that is genuinely outside every path
 * `buildAgentSandboxPolicy` grants — deliberately *not* under `tmpdir()`.
 * The agent sandbox's own allow-list grants the whole of `tmpdir()`
 * broadly (npm/pip/uv caches, AC4), by design, so a target under it would
 * silently prove nothing about AC1: it would already be allowed to write
 * there regardless of the escape attempt below. `/var/tmp` is a real,
 * world-writable directory distinct from `tmpdir()` on this project's own
 * dev/CI hosts.
 */
async function outsideTheSandboxDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join("/var/tmp", prefix));
  cleanupDirs.push(dir);
  return dir;
}

let launcher: SandboxLauncher | undefined;

beforeEach(() => {
  process.env.SLIDRA_SANDBOX_BIN = helperPath;
});

afterEach(async () => {
  delete process.env.SLIDRA_SANDBOX_BIN;
  await launcher?.dispose();
  launcher = undefined;
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Only Linux is exercised here — this pod (and this project's CI) has no
// macOS runner to prove `srt-launcher.ts`'s Seatbelt path against; that
// platform's own dependency (`@anthropic-ai/sandbox-runtime`) is left to
// its own upstream test suite.
describe.skipIf(!isLinux)("Landlock write enforcement (AC1)", () => {
  it("a write assembled from a shell variable, outside the sandbox, fails at the OS level — not at the string check", async () => {
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const outsideDir = await outsideTheSandboxDir("slidra-os-enforce-outside-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createLandlockLauncher();

    // Assembled from a shell variable at run time — the exact shape a
    // string check over the command text would not catch (it never
    // appears as a literal path in the command string itself).
    const shellCommand = `T="${outsideDir}"; printf x > "$T/escape.txt"`;
    const wrapped = await launcher.wrap({ command: "sh", args: ["-c", shellCommand], env: process.env }, policy);
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    await expect(stat(path.join(outsideDir, "escape.txt"))).rejects.toThrow();

    // Same `it`, per the plan: proves the refusal above is not this
    // string-based check doing the work. `touchesProtectedPath` needs a
    // literal path to match against, and this command never names one.
    const protectedPaths: ProtectedPaths = { slidraHome: "/does-not-exist-in-this-test", agentWorkdir: sandboxRoot };
    expect(touchesProtectedPath(shellCommand, protectedPaths)).toBe(false);
  });

  it("a write inside the allow-listed sandbox root succeeds", async () => {
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createLandlockLauncher();

    const wrapped = await launcher.wrap(
      { command: "sh", args: ["-c", `printf ok > "${sandboxRoot}/inside.txt"`], env: process.env },
      policy,
    );
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(await readFile(path.join(sandboxRoot, "inside.txt"), "utf8")).toBe("ok");
  });
});

describe.skipIf(!isLinux)("Landlock leaves reads unrestricted (AC2 is protected-paths.ts's guarantee, not the OS's)", () => {
  it("reading a file under SLIDRA_HOME through the sandbox succeeds at the OS level — the refusal AC2 requires happens above this layer", async () => {
    const slidraHome = await tempDir("slidra-os-enforce-slidrahome-");
    await writeFile(path.join(slidraHome, "projects.json"), "{}");
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createLandlockLauncher();

    const wrapped = await launcher.wrap(
      { command: "cat", args: [path.join(slidraHome, "projects.json")], env: process.env },
      policy,
    );
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}");
  });
});

describe.skipIf(!isLinux)("outside the sandbox, reads and network stay open (AC3)", () => {
  it("reading an unrelated file elsewhere on the machine succeeds", async () => {
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createLandlockLauncher();

    const wrapped = await launcher.wrap({ command: "cat", args: ["/etc/hostname"], env: process.env }, policy);
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });
    const expected = await readFile("/etc/hostname", "utf8");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it("an outbound request to a loopback HTTP server succeeds", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const sandboxRoot = await tempDir("slidra-os-enforce-root-");
      const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
      launcher = await createLandlockLauncher();

      const wrapped = await launcher.wrap(
        { command: "curl", args: ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${String(port)}/`], env: process.env },
        policy,
      );
      // `spawn`, not `spawnSync`: the server above runs in this same
      // process, on this same event loop — a *synchronous* spawn would
      // block that loop for as long as curl waits for a response, and
      // curl's request could then never actually be handled (a real
      // deadlock, not a slow test — reproduced while writing this).
      const { status, stdout } = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ status: code, stdout: out }));
      });

      expect(status).toBe(0);
      expect(stdout).toBe("200");
    } finally {
      // `close()`'s callback only fires once every open connection ends on
      // its own — a keep-alive connection curl leaves lingering would hang
      // this indefinitely. `closeAllConnections()` (Node >=18.19, same
      // pattern `serve.ts` itself uses for shutdown) forces them shut first.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.skipIf(!isLinux)("existing credentials and CLI logins keep working with no extra configuration (AC4)", () => {
  it("HOME inside the sandbox is unchanged, and writing into an existing ~/.claude keeps working", async () => {
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const fakeHome = await tempDir("slidra-os-enforce-home-");
    await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: fakeHome });
    launcher = await createLandlockLauncher();

    const homeCheck = await launcher.wrap(
      { command: "sh", args: ["-c", "printf %s \"$HOME\""], env: { ...process.env, HOME: fakeHome } },
      policy,
    );
    const homeResult = spawnSync(homeCheck.command, homeCheck.args, { env: homeCheck.env, encoding: "utf8" });
    expect(homeResult.status).toBe(0);
    expect(homeResult.stdout).toBe(fakeHome);

    const probePath = path.join(fakeHome, ".claude", "probe.json");
    const writeCheck = await launcher.wrap(
      { command: "sh", args: ["-c", `printf ok > "${probePath}"`], env: process.env },
      policy,
    );
    const writeResult = spawnSync(writeCheck.command, writeCheck.args, { env: writeCheck.env, encoding: "utf8" });
    expect(writeResult.status).toBe(0);
    expect(await readFile(probePath, "utf8")).toBe("ok");
  });
});
