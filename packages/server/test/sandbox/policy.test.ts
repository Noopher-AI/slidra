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
    expect(policy.allowWrite).toContain(path.join(home, ".config"));
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

  it("denies ~/Slidra only when it already exists as a directory, so bwrap never mounts an empty file over a path T2 still needs to mkdir", async () => {
    const withoutIt = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(withoutIt.denyRead).not.toContain(path.join(home, "Slidra"));

    await mkdir(path.join(home, "Slidra"));
    const withIt = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(withIt.denyRead).toContain(path.join(home, "Slidra"));
  });

  it("does not deny ~/Slidra when that name exists but is a file, not a directory", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "Slidra"), "not a directory");
    const policy = await buildAgentSandboxPolicy({ sandboxRoot: "/tmp/root", home });
    expect(policy.denyRead).not.toContain(path.join(home, "Slidra"));
  });
});

describe("buildCliSandboxPolicy", () => {
  it("allows only the bound deck, its -wal/-shm/-journal siblings, SLIDRA_HOME, and tmpdir (AC8)", () => {
    const policy = buildCliSandboxPolicy({ deckPath: "/decks/current.slidra" });
    expect(policy.allowWrite).toEqual([
      "/decks/current.slidra",
      "/decks/current.slidra-wal",
      "/decks/current.slidra-shm",
      "/decks/current.slidra-journal",
      slidraHome,
      tmpdir(),
    ]);
  });

  it("never allows an arbitrary path outside the deck and SLIDRA_HOME — the guard `slidra extract <deck> ~/.ssh/` depends on", () => {
    const policy = buildCliSandboxPolicy({ deckPath: "/decks/current.slidra" });
    expect(policy.allowWrite).not.toContain(path.join(home, ".ssh"));
    expect(policy.denyRead).toEqual([]);
  });
});
