// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SlidraError } from "../slidra/errors.js";
import { resolveSlidraHome } from "../slidra/home.js";
import { AGENT_KINDS, type AgentKind, type DeclaredAdapterConfig } from "./adapters.js";

/**
 * User-level agent selection, persisted at `<SLIDRA_HOME>/settings.json`.
 * This is the only file this module touches; `resolveSlidraHome()`
 * (never `homedir()` built by hand here) is the single source of truth for
 * where `SLIDRA_HOME` actually is, shared with every other module that
 * reads/writes under it.
 *
 * The file may carry other keys in the future — this module only ever
 * reads/writes the `agent`/`models`/`adapters` keys, and `writeAgentSelection`
 * preserves everything else byte-for-byte (see the "unknown keys" section
 * below).
 */
export interface AgentSettings {
  agent: AgentKind | null;
  /** The model the author last picked, per agent kind — applied to every new session of that kind. */
  models: Partial<Record<AgentKind, string>>;
  /** User-declared third-party adapters (E10.T6/#400 D4) — `[]` when the key is absent or empty. `agent/adapters.ts`'s `buildAdapterRegistry` turns these into `AdapterSpec`s. */
  adapters: readonly DeclaredAdapterConfig[];
}

/** A declared adapter's id must be lowercase, start with a letter or digit, and use only `-` as a separator — no `/`, `..`, whitespace, or uppercase, so it can never collide with a filesystem path or an existing built-in kind by casing alone. */
const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const SETTINGS_FILE_NAME = "settings.json";

export function agentSettingsPath(): string {
  return path.join(resolveSlidraHome(), SETTINGS_FILE_NAME);
}

/**
 * Reads the persisted agent selection.
 *
 * A missing file is not an error — nothing has been chosen yet — and this
 * function never creates one just because it was asked to read it; only
 * `writeAgentSelection` ever creates the file. Everything else that does not
 * parse as a supported agent kind (or null) is an honest failure
 * (`SlidraError`): this module never silently patches a broken file into
 * a default value. The caller (`cli.ts`) is the one place allowed to catch
 * that failure and continue with `agent: null` — this module's job stops at
 * reporting the truth.
 */
export async function readAgentSettings(): Promise<AgentSettings> {
  const filePath = agentSettingsPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { agent: null, models: {}, adapters: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SlidraError(`Malformed settings file, not valid JSON: ${filePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SlidraError(`Malformed settings file, the outermost value must be an object: ${filePath}`);
  }

  const models = readModels((parsed as Record<string, unknown>).models, filePath);
  const adapters = readDeclaredAdapters((parsed as Record<string, unknown>).adapters, filePath);
  const declaredIds = adapters.map((adapter) => adapter.id);

  const value = (parsed as Record<string, unknown>).agent;
  if (value === undefined || value === null) {
    return { agent: null, models, adapters };
  }
  if (typeof value === "string" && ((AGENT_KINDS as readonly string[]).includes(value) || declaredIds.includes(value))) {
    return { agent: value, models, adapters };
  }
  throw new SlidraError(
    `Settings file's agent field is invalid (must be ${[...AGENT_KINDS, ...declaredIds].join(", ")}, or null): ${filePath}`,
  );
}

/**
 * Parses the `adapters` key: an object keyed by adapter id, each value
 * `{ label?, command, args?, env? }` (E10.T6/#400 D4's behaviour table).
 * Absent/empty is `[]`, not an error. Any other key present on a declared
 * adapter (`writeRules`, `network`, `mcp`, `fileEntry`, `sandbox`, ...) is
 * silently ignored — legal but inert (D2): nothing here can ever widen what
 * the sandbox grants.
 */
function readDeclaredAdapters(value: unknown, filePath: string): DeclaredAdapterConfig[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SlidraError(`Settings file's adapters field must be an object keyed by adapter id: ${filePath}`);
  }
  const adapters: DeclaredAdapterConfig[] = [];
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ADAPTER_ID_PATTERN.test(id)) {
      throw new SlidraError(`Settings file's adapters key "${id}" is not a valid adapter id (must match ${ADAPTER_ID_PATTERN}): ${filePath}`);
    }
    if ((AGENT_KINDS as readonly string[]).includes(id)) {
      throw new SlidraError(`Settings file's adapters key "${id}" collides with a built-in agent kind: ${filePath}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SlidraError(`Settings file's adapters.${id} must be an object: ${filePath}`);
    }
    const { label, command, args, env } = raw as Record<string, unknown>;
    if (typeof command !== "string" || command === "") {
      throw new SlidraError(`Settings file's adapters.${id}.command must be a non-empty string: ${filePath}`);
    }
    let parsedArgs: string[] = [];
    if (args !== undefined) {
      if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
        throw new SlidraError(`Settings file's adapters.${id}.args must be an array of strings: ${filePath}`);
      }
      parsedArgs = args;
    }
    const parsedEnv: Record<string, string> = {};
    if (env !== undefined) {
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new SlidraError(`Settings file's adapters.${id}.env must be an object of strings: ${filePath}`);
      }
      for (const [key, envValue] of Object.entries(env as Record<string, unknown>)) {
        if (typeof envValue !== "string") {
          throw new SlidraError(`Settings file's adapters.${id}.env.${key} must be a string: ${filePath}`);
        }
        parsedEnv[key] = envValue;
      }
    }
    if (label !== undefined && typeof label !== "string") {
      throw new SlidraError(`Settings file's adapters.${id}.label must be a string: ${filePath}`);
    }
    adapters.push({ id, label: typeof label === "string" && label !== "" ? label : id, command, args: parsedArgs, env: parsedEnv });
  }
  return adapters;
}

/** `models` is keyed by agent kind; absent means nothing picked yet. Other keys are ignored, a wrong shape is an error. */
function readModels(value: unknown, filePath: string): Partial<Record<AgentKind, string>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SlidraError(`Settings file's models field must be an object: ${filePath}`);
  }
  const models: Partial<Record<AgentKind, string>> = {};
  for (const kind of AGENT_KINDS) {
    const id = (value as Record<string, unknown>)[kind];
    if (id === undefined) continue;
    if (typeof id !== "string" || id === "") {
      throw new SlidraError(`Settings file's models.${kind} must be a non-empty string: ${filePath}`);
    }
    models[kind] = id;
  }
  return models;
}

/**
 * Persists the user's agent selection. Preserves every other top-level key
 * already in the file (future F3/F4 settings) — only `agent` is overwritten.
 * `mkdir`s `SLIDRA_HOME` if it does not exist yet, and writes through a
 * temp file + `rename` in the same directory so a crash or full disk
 * mid-write can never leave `settings.json` truncated or half-written —
 * the same discipline `workspace.ts`'s `writeRegistry` uses for
 * `projects.json`.
 */
export async function writeAgentSelection(kind: AgentKind): Promise<void> {
  await updateSettings((existing) => ({ ...existing, agent: kind }));
}

/** Persists the model picked for `kind`, keeping the other kind's pick and every other key. */
export async function writeAgentModel(kind: AgentKind, modelId: string): Promise<void> {
  await updateSettings((existing) => {
    const models = typeof existing.models === "object" && existing.models !== null ? (existing.models as Record<string, unknown>) : {};
    return { ...existing, models: { ...models, [kind]: modelId } };
  });
}

async function updateSettings(patch: (existing: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const home = resolveSlidraHome();
  const finalPath = agentSettingsPath();
  await mkdir(home, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(finalPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (error) {
    // A missing or unreadable/malformed existing file is not this
    // function's problem to diagnose — it is about to be replaced whole
    // with a valid one. Only ENOENT and a JSON/shape failure are expected
    // here; any other I/O failure (e.g. EACCES) surfaces below when the
    // actual write is attempted.
    if (!isEnoent(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const next = patch(existing);
  const tempPath = path.join(home, `.${SETTINGS_FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
