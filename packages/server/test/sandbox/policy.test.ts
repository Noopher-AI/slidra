// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectsRegistry } from "../../src/slidra/home.js";
import { buildAgentSandboxPolicy, buildCliSandboxPolicy } from "../../src/sandbox/policy.js";

let slidraHome: string;
let home: string;

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-policy-home-"));
  home = await mkdtemp(path.join(tmpdir(), "slidra-policy-user-"));
  process.env.SLIDRA_HOME = slidraHome;
});

afterEach(async () => {
  delete process.env.SLIDRA_HOME;
  await rm(slidraHome, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("buildAgentSandboxPolicy", () => {
  it("allow-list always includes the sandbox root, tmpdir, and the credential/cache directories every agent tool needs (AC4/AC8)", async () => {
    const sandboxRoot = "/tmp/some-sandbox-root";
    const policy = await buildAgentSandboxPolicy({ sandboxRoot, home });
    expect(policy.allowWrite).toContain(sandboxRoot);
    expect(policy.allowWrite).toContain(tmpdir());
    expect(policy.allowWrite).toContain(path.join(home, ".claude"));
    expect(policy.allowWrite).toContain(path.join(home, ".claude.json"));
    expect(policy.allowWrite).toContain(path.join(home, ".codex"));
    expect(policy.allowWrite).toContain(path.join(home, ".npm"));
    // `uv` always caches under `~/.cache/uv`, ignoring macOS's own
    // `~/Library/Caches` convention — both must be writable there.
    expect(policy.allowWrite).toContain(path.join(home, ".cache"));
    expect(policy.allowWrite).toContain(path.join(home, ".config"));
    // `cmd > /dev/null 2>&1` is common enough in shell tooling that
    // Landlock's write restriction would otherwise break it (found via
    // os-enforcement.test.ts's AC3 probe).
    expect(policy.allowWrite).toContain("/dev/null");
  });

  it("never allow-lists the home directory itself, ~/.ssh, or SLIDRA_HOME", async () => {
    const policy = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(policy.allowWrite).not.toContain(home);
    expect(policy.allowWrite).not.toContain(path.join(home, ".ssh"));
    expect(policy.allowWrite).not.toContain(slidraHome);
  });

  it("denies reading SLIDRA_HOME and every registry entry's deckPath/sourcePath (AC2)", async () => {
    await writeProjectsRegistry(
      new Map([
        ["pres-a", { deckPath: "/decks/a.slidra", sourcePath: "/original/a.slidra" }],
        ["pres-b", { deckPath: "/decks/b.slidra" }],
      ]),
    );
    const policy = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(policy.denyRead).toContain(slidraHome);
    expect(policy.denyRead).toContain("/decks/a.slidra");
    expect(policy.denyRead).toContain("/original/a.slidra");
    expect(policy.denyRead).toContain("/decks/b.slidra");
  });

  // `denyRead` is consumed only by `srt-launcher.ts` (macOS) — Linux's
  // `landlock-launcher.ts` ignores it entirely (NOOP-425 L6), since a
  // write-only Landlock ruleset has no read-restriction concept to apply it
  // to. Kept here (not moved/duplicated) because the array's *contents* are
  // still produced by this platform-agnostic function.
  it("denies ~/Slidra only when it already exists as a directory — never a bare file, never a path absent from disk (macOS srt path only)", async () => {
    const { writeFile } = await import("node:fs/promises");

    const beforeItExists = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(beforeItExists.denyRead).not.toContain(path.join(home, "Slidra"));

    await writeFile(path.join(home, "Slidra"), "not a directory");
    const asAFile = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(asAFile.denyRead).not.toContain(path.join(home, "Slidra"));

    await rm(path.join(home, "Slidra"));
    await mkdir(path.join(home, "Slidra"));
    const asADirectory = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(asADirectory.denyRead).toContain(path.join(home, "Slidra"));
  });
});

describe("buildCliSandboxPolicy", () => {
  it("allows the deck's parent directory (not just the deck by name), SLIDRA_HOME, and tmpdir (AC8, L5)", () => {
    const policy = buildCliSandboxPolicy({ deckPath: "/decks/current.slidra" });
    expect(policy.allowWrite).toEqual(["/decks", slidraHome, tmpdir()]);
  });

  it("never allows an arbitrary path outside the deck's directory and SLIDRA_HOME — the guard `slidra extract <deck> ~/.ssh/` depends on", () => {
    const policy = buildCliSandboxPolicy({ deckPath: "/decks/current.slidra" });
    expect(policy.allowWrite).not.toContain(path.join(home, ".ssh"));
    expect(policy.denyRead).toEqual([]);
  });
});
