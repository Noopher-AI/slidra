// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectsRegistry } from "../../src/slidra/home.js";
import {
  buildCliSandboxPolicy,
  collectSandboxContext,
  deriveCliSandboxConfig,
  deriveSandboxConfig,
  setActivePolicy,
} from "../../src/sandbox/policy.js";
import { openPolicy } from "../../src/policy/open.js";
import type { SandboxContext } from "../../src/policy/types.js";
import { ADAPTER_SPECS } from "../../src/agent/adapters.js";

const openPolicyTsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/policy/open.ts");

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
    // E10.T6/#400 D1: every bundled adapter's own state directory is now
    // data (`ADAPTER_SPECS[*].writeRules`), not spelled out here — the
    // assertion's source moved with it, but the resolved paths (AC2) did not:
    // this is still exactly `.claude`, `.claude.json`, `.codex`.
    for (const spec of ADAPTER_SPECS) {
      for (const rule of spec.writeRules) {
        if (rule.kind !== "homeEntry") throw new Error(`unexpected writeRules kind in test fixture: ${rule.kind}`);
        expect(policy.allowWrite).toContain(path.join(home, ...rule.segments));
      }
    }
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

  it("open.ts's own source names no adapter (AC2) — the write rules it grants come entirely from agent/adapters.ts's data now", async () => {
    const source = await readFile(openPolicyTsPath, "utf8");
    expect(source).not.toMatch(/claude|codex|\bpi\b/i);
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
      adapterStateDirs: [],
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

/**
 * Added in review (NOOP-634): `buildCliSandboxPolicy` is the function
 * `shim-endpoint.ts` actually calls, and after policy became an injected
 * object it is no longer a self-contained builder — it assembles its own
 * `SandboxContext` around the active policy. The tests above now cover the
 * pure `deriveCliSandboxConfig`, which leaves that assembly unguarded:
 * rewriting its `deckDirectory` to `"/"` (so the CLI sandbox may write
 * anywhere) kept the whole sandbox suite green.
 */
describe("buildCliSandboxPolicy — the wrapper shim-endpoint.ts calls", () => {
  afterEach(() => {
    setActivePolicy(undefined);
  });

  it("resolves the deck's own parent directory against the active policy, never a wider root", () => {
    setActivePolicy(openPolicy);
    const config = buildCliSandboxPolicy({ deckPath: "/decks/current.slidra" });
    expect(config.allowWrite).toEqual(["/decks", slidraHome, tmpdir()]);
    expect(config.allowWrite).not.toContain("/");
  });

  it("refuses to build anything when no policy has been selected — never falls back to a built-in default", () => {
    expect(() => buildCliSandboxPolicy({ deckPath: "/decks/current.slidra" })).toThrow(/active policy/);
  });
});
