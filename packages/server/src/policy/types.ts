// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * The four dimensions #399's `## architecture` comment names as a
 * workbench's policy: outbound network, how files enter, the MCP
 * allow-list, and the sandbox's read/write rules. An edition selects one
 * `WorkbenchPolicy` object (`src/policy/open.ts` is the open edition's); no
 * module that consumes it may name which edition it got — that is what
 * makes a closed policy selectable in tests without editing a single
 * consumer (AC1).
 */

/** Whether a workbench's agent may reach the network at all. No finer grain than this — a boundary a person can widen is not one (#399 arch 5). */
export interface NetworkPolicy {
  readonly outbound: "unrestricted" | "denied";
}

/** The three ways a file can enter a workbench (`POST /api/asset`'s two headers, plus the CLI's own local-path `asset import`). */
export interface FileEntryPolicy {
  readonly uploadBytes: boolean;
  readonly remoteUrl: boolean;
  readonly localPath: boolean;
}

/** One MCP server, in the shape `newSession({ mcpServers })` and the shipped allow-list file both need. */
export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

/**
 * A symbolic filesystem rule — never a literal absolute path baked into a
 * policy object. `deriveSandboxConfig`/`deriveCliSandboxConfig`
 * (`sandbox/policy.ts`) are the only code that resolves one of these
 * against a `SandboxContext`, which is where the actual paths on this
 * machine live. Keeping the policy itself free of real paths is what makes
 * "the sandbox configuration is a pure function of the policy" (AC2) mean
 * something: the same policy object, run against a different `ctx`,
 * produces a config for a different machine/workbench — never a config for
 * a different *policy*.
 */
export type FsRule =
  | { readonly kind: "workbenchRoot" }
  | { readonly kind: "tempDir" }
  | { readonly kind: "slidraHome" }
  | { readonly kind: "openDeckPaths" }
  | { readonly kind: "deckFolderIfPresent" }
  | { readonly kind: "deckDirectory" }
  | { readonly kind: "literal"; readonly path: string; readonly onlyOn?: NodeJS.Platform }
  | { readonly kind: "homeEntry"; readonly segments: readonly string[]; readonly onlyOn?: NodeJS.Platform }
  /**
   * The union of every *bundled* adapter's own state directories
   * (`agent/adapters.ts`'s `AdapterSpec.writeRules`) — never a user-declared
   * adapter's own, which is always `[]` (spec decision 7: a person picks
   * which agent to use and nothing else). Resolved by `collectSandboxContext`
   * into `ctx.adapterStateDirs`, so `open.ts` itself never spells out
   * `.claude`/`.claude.json`/`.codex` again (AC2 — effective rules unchanged).
   */
  | { readonly kind: "adapterState" };

/** The sandbox's read/write rules, one array of `FsRule` per purpose. `cliAllowWrite` is the CLI-sandbox's own (narrower) allow-list — `buildCliSandboxPolicy`'s only consumer. */
export interface FilesystemPolicy {
  readonly allowWrite: readonly FsRule[];
  readonly denyWrite: readonly FsRule[];
  readonly denyRead: readonly FsRule[];
  readonly cliAllowWrite: readonly FsRule[];
}

/**
 * One edition's whole policy — the object `cli.ts` selects and every other
 * module receives as a parameter, never as a constant. `label` is
 * diagnostic only: nothing may branch on it (that would defeat AC1 the
 * same way naming the edition directly would).
 */
export interface WorkbenchPolicy {
  readonly label: string;
  readonly network: NetworkPolicy;
  readonly fileEntry: FileEntryPolicy;
  readonly mcp: { readonly servers: readonly McpServerSpec[] };
  readonly filesystem: FilesystemPolicy;
}

/**
 * The facts about one running workbench that `FsRule`s resolve against —
 * everything `deriveSandboxConfig`/`deriveCliSandboxConfig` need to turn a
 * policy into real paths, and nothing else (no policy content lives here).
 * `collectSandboxContext` is the only place that gathers this with I/O;
 * derivation itself stays synchronous and I/O-free.
 */
export interface SandboxContext {
  readonly workbenchRoot: string;
  readonly home: string;
  readonly tempDir: string;
  readonly platform: NodeJS.Platform;
  readonly slidraHome: string;
  readonly openDeckPaths: readonly string[];
  /** `~/Slidra`, but only when it already exists on disk *and* is a directory — never a bare string for "does not exist" (mirrors the pre-existing `isExistingDirectory` guard). */
  readonly deckFolder: string | null;
  /** The open deck's own directory — set only for the CLI sandbox (`buildCliSandboxPolicy`); null for the agent sandbox, which has no single deck path to anchor `deckDirectory` rules to. */
  readonly deckDirectory: string | null;
  /** Real paths an `"adapterState"` rule resolves to — every *bundled* adapter's own state directory, regardless of which one is current (AC2: collectSandboxContext's own default, not a narrower per-selection set). */
  readonly adapterStateDirs: readonly string[];
}

/**
 * The one serializer for `<workbench>/.agents/mcp-servers.json` — written
 * once at workbench startup (`agent/workdir.ts`'s `deployAgentWorkdir`) and
 * never read back by this process (`newSession` always reads the policy
 * object in memory, never this file): if a session read the file instead,
 * an agent could rewrite it mid-session and self-grant more MCP servers
 * before its next reconnect. `AC3` — "byte-identical to what the program
 * ships" — is this function's own output, so any caller that wants to
 * assert AC3 calls this rather than re-deriving the expected bytes another
 * way.
 */
export function serializeMcpAllowList(policy: Pick<WorkbenchPolicy, "mcp">): string {
  return `${JSON.stringify(policy.mcp.servers, null, 2)}\n`;
}
