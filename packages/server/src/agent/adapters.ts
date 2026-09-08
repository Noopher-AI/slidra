import { createRequire } from "node:module";
import type { AgentAdapterConfig } from "./session.js";

/**
 * The two ACP adapters CoMotion knows how to drive. Claude Code and Codex
 * are not themselves ACP servers — each needs its own thin adapter package
 * that speaks ACP over stdio and drives the underlying CLI.
 *
 * NOOP-230: both adapters ship as ordinary npm dependencies of
 * `@co-motion/server` (see `package.json`) rather than something the user
 * installs globally and CoMotion goes looking for on `PATH`. "Which one is
 * installed" is no longer a question serve ever asks — both are always
 * present the moment `npm install` has run; "which one is selected" is a
 * separate, user-level decision (`settings.ts`).
 */
export type AgentKind = "claude" | "codex";

export interface AdapterSpec {
  kind: AgentKind;
  /** Human-readable name used in status and error messages. */
  label: string;
  /** npm package name — the exact version pin lives in `package.json`'s own `dependencies`. */
  npmPackage: string;
  /**
   * Path, relative to the package root, to the bin entry point spawned via
   * `process.execPath` (§3.2 of the ticket — verified by actually
   * installing both packages and resolving/spawning them: `process.execPath`
   * + a resolved path, never the bin path directly and never PATH/`.bin`).
   */
  modulePath: string;
  /**
   * The command probed for login status (§3.3 — actually run against both
   * real CLIs). Centralized here so `probe.ts` never hardcodes either
   * string itself.
   */
  probeCommand: { command: string; args: string[] };
  /** Static text shown to the user for how to log in — always available, whether or not the adapter is currently logged in. */
  loginCommand: string;
}

export const ADAPTER_SPECS: readonly AdapterSpec[] = [
  {
    kind: "claude",
    label: "Claude Code",
    npmPackage: "@zed-industries/claude-code-acp",
    modulePath: "dist/index.js",
    probeCommand: { command: "claude", args: ["auth", "status", "--json"] },
    loginCommand: "claude auth login",
  },
  {
    kind: "codex",
    label: "Codex",
    npmPackage: "@zed-industries/codex-acp",
    modulePath: "bin/codex-acp.js",
    probeCommand: { command: "codex", args: ["login", "status"] },
    loginCommand: "codex login",
  },
];

export function adapterSpecFor(kind: AgentKind): AdapterSpec {
  const spec = ADAPTER_SPECS.find((candidate) => candidate.kind === kind);
  if (!spec) {
    // Unreachable given AgentKind's two literal values — a thrown error
    // here would mean the type and this table have drifted apart.
    throw new Error(`no adapter spec for kind: ${kind}`);
  }
  return spec;
}

// `require.resolve` (not a bare dynamic `import()`) is what actually
// resolves the package's own file layout the same way Node's own module
// resolution would for a CommonJS/mixed dependency tree — this package is
// ESM (`"type": "module"`), so a `require` is synthesized via
// `createRequire` rather than imported directly.
const require = createRequire(import.meta.url);

/**
 * Builds the `AgentAdapterConfig` to spawn `kind`'s adapter: `process.execPath`
 * plus the adapter package's own bin file, resolved through normal Node
 * module resolution from this module's location (workspace hoisting puts
 * both packages in the repo root's `node_modules`, reachable by walking up
 * from `packages/server` — verified in §3.2). Never the bin path spawned
 * directly (breaks on Windows, depends on the exec bit) and never PATH or
 * `node_modules/.bin` — decision §7.1, not up for reconsideration here.
 */
export function resolveAdapterConfig(kind: AgentKind): AgentAdapterConfig {
  const spec = adapterSpecFor(kind);
  const resolved = require.resolve(`${spec.npmPackage}/${spec.modulePath}`);
  // Ask CoMotion before running untrusted commands. Its allow_once gate
  // authorizes the CLI to write presentation history outside the empty
  // ACP cwd, without granting the agent a writable presentation directory.
  const args = kind === "codex"
    ? [resolved, "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="read-only"']
    : [resolved];
  return { kind: spec.kind, label: spec.label, command: process.execPath, args };
}
