// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { resolveSlidraHome } from "../slidra/home.js";
import type { AgentAdapterConfig } from "./session.js";
import type { FsRule } from "../policy/types.js";

/**
 * The ACP adapters Slidra knows how to drive. Claude Code and Codex are not
 * themselves ACP servers, while Pi is embedded by its adapter; each package
 * presents the same ACP-over-stdio boundary to Slidra.
 *
 * NOOP-230: every adapter ships as an ordinary npm dependency of
 * `@slidra/server` (see `package.json`) rather than something the user
 * installs globally and Slidra goes looking for on `PATH`. "Which one is
 * installed" is no longer a question serve ever asks — all are always
 * present the moment `npm install` has run; "which one is selected" is a
 * separate, user-level decision (`settings.ts`).
 */
export const AGENT_KINDS = ["claude", "codex", "pi"] as const;
/**
 * One of the three bundled kinds, or a user-declared adapter's own id
 * (settings.ts's `adapters` key, E10.T6/#400 D4) — no longer a closed union:
 * the whole point of `buildAdapterRegistry` is that the set of valid kinds
 * is a runtime registry, not a compile-time enum. `AGENT_KINDS` above is
 * still the closed, three-value list for code that specifically means "one
 * of the bundled adapters" (`settings.ts`'s `models` map, in particular).
 */
export type AgentKind = string;

/** True when `value` names a kind present in `registry` — a bundled one or a registered custom one. There is deliberately no default registry: a call site must say which set of kinds it means (E10.T6 D4). */
export function isAgentKind(value: unknown, registry: readonly AdapterSpec[]): value is AgentKind {
  return typeof value === "string" && registry.some((spec) => spec.kind === value);
}

export interface AdapterSpec {
  kind: AgentKind;
  /** Human-readable name used in status and error messages. */
  label: string;
  /** npm package name — the exact version pin lives in `package.json`'s own `dependencies`. Present only for a bundled adapter; a user-declared one carries `custom` instead. */
  npmPackage?: string;
  /**
   * Path, relative to the package root, to the bin entry point spawned via
   * `process.execPath` (§3.2 of the ticket — verified by actually
   * installing both packages and resolving/spawning them: `process.execPath`
   * + a resolved path, never the bin path directly and never PATH/`.bin`).
   * Present only for a bundled adapter.
   */
  modulePath?: string;
  /**
   * The command probed for login status (§3.3 — actually run against both
   * real CLIs). Centralized here so `probe.ts` never hardcodes either
   * string itself. Absent for a user-declared adapter, which has no login
   * concept Slidra can probe — its card is always reported "available"
   * (`agent/manager.ts`'s `probeOne`), never spawning anything to check.
   */
  probeCommand?: { command: string; args: string[] };
  /** Static text shown to the user for how to log in — always available for a bundled adapter, whether or not it is currently logged in. Absent for a user-declared adapter (no `probeCommand`, nothing to log into). */
  loginCommand?: string;
  /**
   * The sandbox write rules this adapter's own session state needs
   * (E10.T6/#400 D1) — resolved into `SandboxContext.adapterStateDirs` by
   * `sandbox/policy.ts`'s `collectSandboxContext`. Always `[]` for a
   * user-declared adapter (D2): a person picks *which* agent to use, never
   * what it may write — that is a policy decision, not a per-adapter one.
   */
  writeRules: readonly FsRule[];
  /**
   * Present only for a user-declared adapter (settings.ts's `adapters`
   * key) — `resolveAdapterConfig` spawns this directly instead of
   * resolving an npm package, and skips every bundled-adapter-specific
   * tweak below (CLAUDE_CODE_EXECUTABLE, CODEX_PATH, the Pi model catalog).
   */
  custom?: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> };
}

export const ADAPTER_SPECS: readonly AdapterSpec[] = [
  {
    kind: "claude",
    label: "Claude Code",
    npmPackage: "@zed-industries/claude-code-acp",
    modulePath: "dist/index.js",
    probeCommand: { command: "claude", args: ["auth", "status", "--json"] },
    loginCommand: "claude auth login",
    writeRules: [{ kind: "homeEntry", segments: [".claude"] }, { kind: "homeEntry", segments: [".claude.json"] }],
  },
  {
    kind: "codex",
    label: "Codex",
    npmPackage: "@agentclientprotocol/codex-acp",
    modulePath: "dist/index.js",
    probeCommand: { command: "codex", args: ["login", "status"] },
    loginCommand: "codex login",
    writeRules: [{ kind: "homeEntry", segments: [".codex"] }],
  },
  {
    kind: "pi",
    label: "Pi (Local Qwen)",
    npmPackage: "@automatalabs/pi-acp",
    modulePath: "dist/index.js",
    probeCommand: {
      command: process.execPath,
      args: [
        "-e",
        `const base=(process.env.SLIDRA_PI_BASE_URL||"http://127.0.0.1:11434/v1").replace(/\\/+$/,"");
const model=process.env.SLIDRA_PI_MODEL||"qwen2.5-coder:7b";
const key=process.env.SLIDRA_PI_API_KEY||"local";
fetch(base+"/models",{headers:{Authorization:"Bearer "+key},signal:AbortSignal.timeout(4000)})
  .then(async response=>{
    if(!response.ok) process.exit(1);
    const payload=await response.json();
    process.exit(Array.isArray(payload.data)&&payload.data.some(candidate=>candidate&&candidate.id===model)?0:1);
  })
  .catch(()=>process.exit(1));`,
      ],
    },
    loginCommand: "ollama run qwen2.5-coder:7b",
    writeRules: [],
  },
];

/**
 * A user-declared adapter, parsed from `<SLIDRA_HOME>/settings.json`'s
 * `adapters` key (`agent/settings.ts`'s `readAgentSettings`). Only these
 * four fields are ever read from what a person writes there — spec decision
 * 7: a person picks *which* agent to use and nothing else, so nothing here
 * can express a write rule, network exception, or MCP server.
 */
export interface DeclaredAdapterConfig {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The effective set of adapters for one running server: every bundled one,
 * first (§7 decision 5 — a declared id can never shadow a built-in kind;
 * `settings.ts` is what actually enforces the collision refusal, this
 * function assumes `declared` already passed that check), then every
 * user-declared one, each carrying `writeRules: []` (D2) and no
 * `probeCommand`/`loginCommand` (a declared adapter is always reported
 * "available" — see `agent/manager.ts`'s `probeOne`, never spawning
 * anything to check a login status it has no concept of).
 */
export function buildAdapterRegistry(declared: readonly DeclaredAdapterConfig[]): readonly AdapterSpec[] {
  const custom: AdapterSpec[] = declared.map((adapter) => ({
    kind: adapter.id,
    label: adapter.label,
    writeRules: [],
    custom: { command: adapter.command, args: adapter.args, env: adapter.env },
  }));
  return [...ADAPTER_SPECS, ...custom];
}

export function adapterSpecFor(kind: AgentKind, registry: readonly AdapterSpec[] = ADAPTER_SPECS): AdapterSpec {
  const spec = registry.find((candidate) => candidate.kind === kind);
  if (!spec) {
    // Unreachable given every caller first checks `isAgentKind(kind, registry)`
    // against this same registry — a thrown error here would mean a caller
    // skipped that check.
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
 *
 * A user-declared adapter (`spec.custom` set — E10.T6/#400) skips all of
 * this: it is spawned exactly as declared, with no package resolution and
 * none of the bundled-adapter-specific tweaks below (CLAUDE_CODE_EXECUTABLE,
 * CODEX_PATH, the Pi model catalog) — those are all about a *specific*
 * bundled CLI's own quirks, meaningless (and potentially wrong) applied to
 * an arbitrary third party's command.
 */
export function resolveAdapterConfig(kind: AgentKind, registry: readonly AdapterSpec[] = ADAPTER_SPECS): AgentAdapterConfig {
  const spec = adapterSpecFor(kind, registry);

  let config: AgentAdapterConfig;
  if (spec.custom) {
    config = { kind: spec.kind, label: spec.label, command: spec.custom.command, args: [...spec.custom.args], env: { ...spec.custom.env } };
  } else {
    // pi-acp exports its library entry but deliberately does not export its
    // executable subpath. Resolve the public entry first, then address the
    // sibling CLI file named by the package's `bin` field.
    const resolved = kind === "pi"
      ? path.join(dirname(require.resolve(spec.npmPackage!)), "index.js")
      : require.resolve(`${spec.npmPackage}/${spec.modulePath}`);
    config = { kind: spec.kind, label: spec.label, command: process.execPath, args: [resolved] };
  }

  // NOOP-278: when the slidra Rust binary execs this Node process as its
  // fallback (crates/slidra/src/fallback.rs), it sets SLIDRA_BIN to
  // its own absolute path but does not itself put its directory on PATH.
  // An agent shelling out to a bare `slidra ...` (as the editing
  // protocol instructs) would otherwise find nothing, since this project
  // never installs a CLI globally — the Rust binary is one link in a chain
  // that also falls back to this very Node process, so its directory needs
  // to be reachable again for that chain to close. When SLIDRA_BIN is
  // unset (today's only real invocation path — no Rust binary yet in the
  // chain), `config.env` stays unset for a bundled adapter and this
  // function's return value is byte-for-byte identical to before this
  // change: the existing e2e fixtures that put `node_modules/.bin` on PATH
  // themselves depend on that being untouched. Applies to a user-declared
  // adapter too (E10.T6/#400 — this is about *Slidra's* PATH, not any
  // adapter's own quirk), merged over its declared `env` rather than
  // replacing it outright.
  const slidraBin = process.env.SLIDRA_BIN;
  if (slidraBin) {
    config.env = { ...config.env, PATH: `${dirname(slidraBin)}:${config.env?.PATH ?? process.env.PATH ?? ""}` };
  }

  if (spec.custom) return config;

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

  if (kind === "pi") {
    // Pi supports many providers. This Slidra choice intentionally means a
    // single local Qwen endpoint speaking OpenAI Chat Completions. Keep its
    // config isolated, write the one-provider catalog ourselves, and mask
    // ambient cloud credentials inherited by serve.
    const agentDir = path.join(resolveSlidraHome(), "pi-local-qwen");
    const baseUrl = process.env.SLIDRA_PI_BASE_URL?.trim() || "http://127.0.0.1:11434/v1";
    const model = process.env.SLIDRA_PI_MODEL?.trim() || "qwen2.5-coder:7b";
    const apiKey = process.env.SLIDRA_PI_API_KEY?.trim() || "local";
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify({
      providers: {
        "local-qwen": {
          baseUrl,
          api: "openai-completions",
          apiKey: "$SLIDRA_PI_API_KEY",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            thinkingFormat: "qwen-chat-template",
          },
          models: [{ id: model, name: `Local Qwen (${model})`, reasoning: true }],
        },
      },
    }, null, 2)}\n`);
    config.env = {
      ...config.env,
      PI_CODING_AGENT_DIR: agentDir,
      SLIDRA_PI_API_KEY: apiKey,
      ANTHROPIC_API_KEY: "",
      ANT_LING_API_KEY: "",
      AZURE_OPENAI_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      NVIDIA_API_KEY: "",
      GEMINI_API_KEY: "",
      AWS_BEARER_TOKEN_BEDROCK: "",
      MISTRAL_API_KEY: "",
      GROQ_API_KEY: "",
      CEREBRAS_API_KEY: "",
      CLOUDFLARE_API_KEY: "",
      XAI_API_KEY: "",
      AI_GATEWAY_API_KEY: "",
      ZAI_API_KEY: "",
      OPENCODE_API_KEY: "",
      RADIUS_API_KEY: "",
      HF_TOKEN: "",
      FIREWORKS_API_KEY: "",
      TOGETHER_API_KEY: "",
      BASETEN_API_KEY: "",
      KIMI_API_KEY: "",
      MINIMAX_API_KEY: "",
      MINIMAX_CN_API_KEY: "",
      QWEN_TOKEN_PLAN_API_KEY: "",
      QWEN_TOKEN_PLAN_CN_API_KEY: "",
      XIAOMI_API_KEY: "",
      XIAOMI_TOKEN_PLAN_CN_API_KEY: "",
      XIAOMI_TOKEN_PLAN_AMS_API_KEY: "",
      XIAOMI_TOKEN_PLAN_SGP_API_KEY: "",
    };
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
