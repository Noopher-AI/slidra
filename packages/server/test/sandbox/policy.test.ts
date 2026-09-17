// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectsRegistry } from "../../src/slidra/home.js";
import { collectSandboxContext, deriveCliSandboxConfig, deriveSandboxConfig } from "../../src/sandbox/policy.js";
import { openPolicy } from "../../src/policy/open.js";
import type { SandboxContext } from "../../src/policy/types.js";

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

describe("deriveSandboxConfig(openPolicy, ctx) — the agent sandbox", () => {
  it("allow-list always includes the sandbox root, tmpdir, and the credential/cache directories every agent tool needs (AC4/AC8)", async () => {
    const sandboxRoot = "/tmp/some-sandbox-root";
    const ctx = await collectSandboxContext({ workbenchRoot: sandboxRoot, home });
    const policy = deriveSandboxConfig(openPolicy, ctx);
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
    const ctx = await collectSandboxContext({ workbenchRoot: "/tmp/root", home });
    const policy = deriveSandboxConfig(openPolicy, ctx);
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
    const ctx = await collectSandboxContext({ workbenchRoot: "/tmp/root", home });
    const policy = deriveSandboxConfig(openPolicy, ctx);
    expect(policy.denyRead).toContain(slidraHome);
    expect(policy.denyRead).toContain("/decks/a.slidra");
    expect(policy.denyRead).toContain("/original/a.slidra");
    expect(policy.denyRead).toContain("/decks/b.slidra");
  });
});

describe("collectSandboxContext", () => {
  // `deckFolder` is consumed only by `srt-launcher.ts` (macOS) via
  // `denyRead` — Linux's `landlock-launcher.ts` ignores `denyRead` entirely
  // (NOOP-425 L6), since a write-only Landlock ruleset has no
  // read-restriction concept to apply it to. This is the one place in the
  // sandbox pipeline that touches the filesystem, so it is what this test
  // exercises directly, rather than the pure `deriveSandboxConfig`.
  it("denies ~/Slidra only when it already exists as a directory — never a bare file, never a path absent from disk (macOS srt path only)", async () => {
    const { writeFile } = await import("node:fs/promises");

    const beforeItExists = await collectSandboxContext({ workbenchRoot: "/tmp/root", home });
    expect(beforeItExists.deckFolder).toBeNull();

    await writeFile(path.join(home, "Slidra"), "not a directory");
    const asAFile = await collectSandboxContext({ workbenchRoot: "/tmp/root", home });
    expect(asAFile.deckFolder).toBeNull();

    await rm(path.join(home, "Slidra"));
    await mkdir(path.join(home, "Slidra"));
    const asADirectory = await collectSandboxContext({ workbenchRoot: "/tmp/root", home });
    expect(asADirectory.deckFolder).toBe(path.join(home, "Slidra"));
  });
});

describe("deriveCliSandboxConfig(openPolicy, ctx) — the CLI sandbox", () => {
  function cliCtx(deckPath: string): SandboxContext {
    return {
      workbenchRoot: "",
      home,
      tempDir: tmpdir(),
      platform: process.platform,
      slidraHome,
      openDeckPaths: [],
      deckFolder: null,
      deckDirectory: path.dirname(deckPath),
    };
  }

  it("allows the deck's parent directory (not just the deck by name), SLIDRA_HOME, and tmpdir (AC8, L5)", () => {
    const policy = deriveCliSandboxConfig(openPolicy, cliCtx("/decks/current.slidra"));
    expect(policy.allowWrite).toEqual(["/decks", slidraHome, tmpdir()]);
  });

  it("never allows an arbitrary path outside the deck's directory and SLIDRA_HOME — the guard `slidra extract <deck> ~/.ssh/` depends on", () => {
    const policy = deriveCliSandboxConfig(openPolicy, cliCtx("/decks/current.slidra"));
    expect(policy.allowWrite).not.toContain(path.join(home, ".ssh"));
    expect(policy.denyRead).toEqual([]);
  });
});
