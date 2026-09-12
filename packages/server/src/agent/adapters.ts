import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { resolveSlidraHome } from "../slidra/home.js";
import type { AgentAdapterConfig } from "./session.js";

/**
 * The two ACP adapters Slidra knows how to drive. Claude Code and Codex
 * are not themselves ACP servers — each needs its own thin adapter package
 * that speaks ACP over stdio and drives the underlying CLI.
 *
 * NOOP-230: both adapters ship as ordinary npm dependencies of
 * `@slidra/server` (see `package.json`) rather than something the user
 * installs globally and Slidra goes looking for on `PATH`. "Which one is
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
    npmPackage: "@agentclientprotocol/codex-acp",
    modulePath: "dist/index.js",
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
  const config: AgentAdapterConfig = { kind: spec.kind, label: spec.label, command: process.execPath, args: [resolved] };

  // NOOP-278: when the slidra Rust binary execs this Node process as its
  // fallback (crates/slidra/src/fallback.rs), it sets SLIDRA_BIN to
  // its own absolute path but does not itself put its directory on PATH.
  // An agent shelling out to a bare `slidra ...` (as the editing
  // protocol instructs) would otherwise find nothing, since this project
  // never installs a CLI globally — the Rust binary is one link in a chain
  // that also falls back to this very Node process, so its directory needs
  // to be reachable again for that chain to close. When SLIDRA_BIN is
  // unset (today's only real invocation path — no Rust binary yet in the
  // chain), `config.env` stays unset and this function's return value is
  // byte-for-byte identical to before this change: the existing e2e
  // fixtures that put `node_modules/.bin` on PATH themselves depend on
  // that being untouched.
  const slidraBin = process.env.SLIDRA_BIN;
  if (slidraBin) {
    config.env = { PATH: `${dirname(slidraBin)}:${process.env.PATH ?? ""}` };
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

  if (kind === "codex") {
    // The read-only preset is what makes Slidra the gate: a `slidra`
    // command that writes cannot run inside the sandbox, so Codex has to
    // ask, and `decidePermission` answers with the allowlist. The mode is
    // the adapter's own env knob (it replaces the old `-c approval_policy`
    // / `-c sandbox_mode` flags of @zed-industries/codex-acp).
    config.env = { ...config.env, INITIAL_AGENT_MODE: "read-only" };
    // `@agentclientprotocol/codex-acp` bundles its own Codex, but the one
    // the author installed (and logged in with — `probeCommand` looks it up
    // on PATH) is the one whose model list and account they expect to see.
    // It goes through a tiny launcher rather than straight into
    // `CODEX_PATH` because Codex runs commands in a login shell whose
    // startup files rebuild PATH — the serve process's own PATH (where
    // `slidra` lives) never reaches the sandbox otherwise. The launcher
    // passes `-c allow_login_shell=false`, which the adapter offers no other
    // way to set (`CODEX_CONFIG` is merged per thread, and Codex reads this
    // key at startup only).
    const codex = findOnPath("codex");
    if (codex && process.platform !== "win32") {
      config.env = { ...config.env, CODEX_PATH: writeCodexLauncher(codex) };
    }
  }

  return config;
}

/**
 * Writes `<SLIDRA_HOME>/codex-launcher.sh`, an `exec` of the real Codex
 * with `-c allow_login_shell=false` in front of the adapter's own
 * `app-server` argument, and returns its path. Rewritten on every resolve
 * (the Codex path may have moved since last time); a stale copy from an
 * older serve is simply overwritten.
 */
function writeCodexLauncher(codexPath: string): string {
  const home = resolveSlidraHome();
  mkdirSync(home, { recursive: true });
  const launcher = path.join(home, "codex-launcher.sh");
  writeFileSync(launcher, `#!/bin/sh
exec ${shellQuote(codexPath)} -c allow_login_shell=false "$@"
`, { mode: 0o755 });
  chmodSync(launcher, 0o755);
  return launcher;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
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
