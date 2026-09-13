// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SlidraError } from "../slidra/errors.js";
import { resolveSlidraHome } from "../slidra/home.js";
import { AGENT_KINDS, isAgentKind, type AgentKind } from "./adapters.js";

/**
 * User-level agent selection, persisted at `<SLIDRA_HOME>/settings.json`.
 * This is the only file this module touches; `resolveSlidraHome()`
 * (never `homedir()` built by hand here) is the single source of truth for
 * where `SLIDRA_HOME` actually is, shared with every other module that
 * reads/writes under it.
 *
 * The file may carry other keys in the future — this module only ever
 * reads/writes the `agent` key, and `writeAgentSelection` preserves
 * everything else byte-for-byte (see the "unknown keys" section below).
 */
export interface AgentSettings {
  agent: AgentKind | null;
  /** The model the author last picked, per agent kind — applied to every new session of that kind. */
  models: Partial<Record<AgentKind, string>>;
}

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
      return { agent: null, models: {} };
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
  const value = (parsed as Record<string, unknown>).agent;
  if (value === undefined || value === null) {
    return { agent: null, models };
  }
  if (isAgentKind(value)) {
    return { agent: value, models };
  }
  throw new SlidraError(`Settings file's agent field is invalid (must be claude, codex, pi, or null): ${filePath}`);
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
