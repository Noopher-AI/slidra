import { createRequire } from "node:module";
import { accessSync, constants, realpathSync } from "node:fs";
import path, { dirname } from "node:path";
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
  const config: AgentAdapterConfig = { kind: spec.kind, label: spec.label, command: process.execPath, args };

  // NOOP-278: when the co-motion Rust binary execs this Node process as its
  // fallback (crates/co-motion/src/fallback.rs), it sets CO_MOTION_BIN to
  // its own absolute path but does not itself put its directory on PATH.
  // An agent shelling out to a bare `co-motion ...` (as the editing
  // protocol instructs) would otherwise find nothing, since this project
  // never installs a CLI globally — the Rust binary is one link in a chain
  // that also falls back to this very Node process, so its directory needs
  // to be reachable again for that chain to close. When CO_MOTION_BIN is
  // unset (today's only real invocation path — no Rust binary yet in the
  // chain), `config.env` stays unset and this function's return value is
  // byte-for-byte identical to before this change: the existing e2e
  // fixtures that put `node_modules/.bin` on PATH themselves depend on
  // that being untouched.
  const coMotionBin = process.env.CO_MOTION_BIN;
  if (coMotionBin) {
    config.env = { PATH: `${dirname(coMotionBin)}:${process.env.PATH ?? ""}` };
  }

  // claude-code-acp drives Claude Code through the Agent SDK, which ships
  // its own (older) copy of the Claude Code CLI — and the model list the
  // adapter reports at `session/new` comes from whichever CLI it runs. The
  // adapter honours `CLAUDE_CODE_EXECUTABLE`, so when the author has Claude
  // Code installed (the same `claude` the login probe already looks up on
  // PATH) point the SDK at it: the models the author can pick are then the
  // ones their own Claude Code offers, not the bundled copy's shorter list.
  // Absent `claude` on PATH, nothing is set and the bundled CLI is used.
  if (kind === "claude") {
    const claude = findOnPath("claude");
    if (claude) config.env = { ...config.env, CLAUDE_CODE_EXECUTABLE: claude };
  }

  return config;
}

/** The first `name` on PATH, resolved through its symlinks (Claude's launcher is a symlink into a versioned directory); undefined when none. */
export function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}
