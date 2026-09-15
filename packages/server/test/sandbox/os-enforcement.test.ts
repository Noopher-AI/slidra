// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-425 AC1/AC2/AC3/AC4: real sandbox enforcement, not a mock. Every
 * test here builds a real `SandboxLauncher` and actually spawns a real
 * child process through it — `createLandlockLauncher()` (Linux) in the
 * describe blocks below, `createSrtLauncher()` (macOS Seatbelt, NOOP-472)
 * in the darwin-only block at the end of this file. "Tested on the
 * `SandboxLauncher` interface" (NOOP-463 plan §6): never on
 * `slidra-sandbox-exec`'s argv shape.
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
import { createSandboxLauncher } from "../../src/sandbox/launcher.js";
import { buildAgentSandboxPolicy } from "../../src/sandbox/policy.js";
import { touchesProtectedPath, type ProtectedPaths } from "../../src/agent/protected-paths.js";
import type { SandboxLauncher } from "../../src/sandbox/launcher.js";

const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";

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
    // Deliberately *not* under `tmpdir()`: the allow-list grants the whole
    // of `tmpdir()` (see `outsideTheSandboxDir`), so a fake home in there
    // would make the write probe below pass even with every credential
    // entry stripped out of `buildAgentSandboxPolicy` — proving nothing.
    const fakeHome = await outsideTheSandboxDir("slidra-os-enforce-home-");
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

  // NOOP-425 §7's open assumption (2), carried into this round as review
  // feedback: does a real CLI's credential refresh survive this allow-list?
  // `claude` updates `~/.claude.json` (token refresh, but also every plain
  // startup's `numStartups`) through an atomic write: stage a sibling
  // `~/.claude.json.tmp.<pid>.<hex>`, then rename it over the target.
  // `$HOME` itself is not on the allow-list, so that staging write is
  // refused — and the allow-list is *meant* to refuse it, since granting
  // `$HOME` would gut `denyRead`. What makes AC4 hold anyway is the
  // fallback the same writer takes when staging fails with EACCES and the
  // target already exists (the logged-in case AC4 is about): it reopens
  // the target itself with O_WRONLY|O_CREAT|O_TRUNC and writes in place.
  // Both halves are asserted here: the refusal is the allow-list's
  // boundary (AC8), the in-place write is AC4 itself. Landlock has to
  // grant TRUNCATE for the second half, which is not implied by the first.
  it("refuses a staged sibling in $HOME but still allows the in-place ~/.claude.json update a credential refresh falls back to", async () => {
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const fakeHome = await outsideTheSandboxDir("slidra-os-enforce-home-");
    const configPath = path.join(fakeHome, ".claude.json");
    await writeFile(configPath, '{"numStartups":1}');
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: fakeHome });
    launcher = await createLandlockLauncher();

    const stagedPath = `${configPath}.tmp.4242.abcdef012345`;
    const staged = await launcher.wrap(
      { command: "sh", args: ["-c", `printf '{}' > "${stagedPath}"`], env: process.env },
      policy,
    );
    const stagedResult = spawnSync(staged.command, staged.args, { env: staged.env, encoding: "utf8" });
    expect(stagedResult.status).not.toBe(0);
    expect(stagedResult.stderr).toContain("Permission denied");

    const inPlace = await launcher.wrap(
      { command: "sh", args: ["-c", `printf '{"numStartups":2}' > "${configPath}"`], env: process.env },
      policy,
    );
    const inPlaceResult = spawnSync(inPlace.command, inPlace.args, { env: inPlace.env, encoding: "utf8" });
    expect(inPlaceResult.status).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe('{"numStartups":2}');
  });
});

// NOOP-472: the macOS counterpart to the Landlock block above, exercising
// `createSrtLauncher()`'s real Seatbelt enforcement instead of a mock.
// `srt-launcher.ts` is imported dynamically inside each `it`, never at
// module scope — mirroring `launcher.ts`'s own dispatch (`createSrtLauncher`
// is only ever imported when `process.platform === "darwin"`), so this file
// keeps loading on Linux CI without pulling in `@anthropic-ai/sandbox-runtime`
// there at all.
describe.skipIf(!isDarwin)("Seatbelt write enforcement on macOS (AC1/AC2/AC3, srt-launcher.ts)", () => {
  it("a write outside the sandbox root is refused by the OS", async () => {
    const { createSrtLauncher } = await import("../../src/sandbox/srt-launcher.js");
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const outsideDir = await outsideTheSandboxDir("slidra-os-enforce-outside-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createSrtLauncher();
    expect(launcher.active).toBe(true);

    const wrapped = await launcher.wrap(
      { command: "sh", args: ["-c", `printf x > "${outsideDir}/escape.txt"`], env: process.env },
      policy,
    );
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    await expect(stat(path.join(outsideDir, "escape.txt"))).rejects.toThrow();
  });

  it("a write inside the allow-listed sandbox root succeeds", async () => {
    const { createSrtLauncher } = await import("../../src/sandbox/srt-launcher.js");
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createSrtLauncher();
    expect(launcher.active).toBe(true);

    const wrapped = await launcher.wrap(
      { command: "sh", args: ["-c", `printf ok > "${sandboxRoot}/inside.txt"`], env: process.env },
      policy,
    );
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(await readFile(path.join(sandboxRoot, "inside.txt"), "utf8")).toBe("ok");
  });

  it("reading a file elsewhere on the machine and an outbound loopback HTTP request both still succeed (AC3)", async () => {
    const { createSrtLauncher } = await import("../../src/sandbox/srt-launcher.js");
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createSrtLauncher();
    expect(launcher.active).toBe(true);

    const readWrapped = await launcher.wrap({ command: "cat", args: ["/etc/hosts"], env: process.env }, policy);
    const readResult = spawnSync(readWrapped.command, readWrapped.args, { env: readWrapped.env, encoding: "utf8" });
    const expected = await readFile("/etc/hosts", "utf8");
    expect(readResult.status).toBe(0);
    expect(readResult.stdout).toBe(expected);

    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const wrapped = await launcher.wrap(
        { command: "curl", args: ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${String(port)}/`], env: process.env },
        policy,
      );
      // `spawn`, not `spawnSync` — same deadlock risk as the Linux AC3 test
      // above (the server runs on this same event loop).
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
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * The launcher contract every caller depends on but no `allowWrite` test
 * touches: `wrap()` must hand back the env the CALLER asked for, not the
 * parent process's. `agent/manager.ts` rewrites `PATH` so the agent resolves
 * `slidra` to `<sandboxRoot>/bin` (the CLI-sandbox shim) rather than to any
 * ambient binary — and `srt-launcher.ts` used to spread `srt`'s own env
 * (which is `process.env` verbatim) *after* the caller's, silently undoing
 * exactly that rewrite. The whole CLI sandbox then went unused on macOS:
 * the agent ran the real `slidra` binary inside the agent sandbox, where
 * `denyRead` covers the deck, so every scripted command failed
 * (freeze.test.ts, first caught by the required-macos job).
 *
 * Runs against `createSandboxLauncher()` — whichever real launcher this
 * platform dispatches to — so neither platform can regress alone.
 */
describe.skipIf(process.platform === "win32")("SandboxLauncher.wrap() preserves the caller's own env (every platform)", () => {
  it("a PATH the caller overrode is what the wrapped command resolves against, not the parent's", async () => {
    const sandboxRoot = await tempDir("slidra-os-enforce-root-");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home: await tempDir("slidra-os-enforce-home-") });
    launcher = await createSandboxLauncher();
    expect(launcher.active).toBe(true);

    // A stand-in for the shim wrapper, under the same name the agent's
    // shell would resolve, in a directory that is on no ambient PATH.
    const binDir = path.join(sandboxRoot, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "slidra"), "#!/bin/sh\necho shim-was-used\n", { mode: 0o755 });

    const wrapped = await launcher.wrap(
      {
        command: "sh",
        args: ["-c", "slidra"],
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      },
      policy,
    );
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8" });

    expect(result.stdout.trim()).toBe("shim-was-used");
    expect(result.status).toBe(0);
  });
});
