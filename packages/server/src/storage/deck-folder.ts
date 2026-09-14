// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SlidraError } from "../slidra/errors.js";
import { agentSettingsPath } from "../agent/settings.js";

/**
 * Where the GUI's own deck lifecycle (create/import/list/rename/delete)
 * reads and writes `.slidra` files — distinct from `SLIDRA_HOME`, which
 * never holds deck content, only the registry/history/clipboards
 * ([E6.T2] plan §7 decision 4). Read fresh on every call, never cached, the
 * same discipline `resolveSlidraHome` uses, for the same reason (tests point
 * it at a temp `settings.json` per case via `SLIDRA_HOME`).
 *
 * The key lives in the same `settings.json` `agent/settings.ts` already
 * owns — this module only ever reads the `deckFolder` key, and never writes
 * it (no command in this ticket's scope changes it).
 */
export async function resolveDeckFolder(): Promise<string> {
  const filePath = agentSettingsPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return defaultDeckFolder();
    throw new SlidraError(`failed to read settings file: ${filePath}`);
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

  const value = (parsed as Record<string, unknown>).deckFolder;
  if (value === undefined || value === null) return defaultDeckFolder();
  if (typeof value !== "string" || value === "") {
    throw new SlidraError(`Settings file's deckFolder field must be a non-empty string: ${filePath}`);
  }
  return value;
}

function defaultDeckFolder(): string {
  return path.join(homedir(), "Slidra");
}

/** Resolves the deck folder and ensures it exists, so a first run against a brand-new home lists as `[]` rather than erroring "not found" (plan §4's behavior table). */
export async function ensureDeckFolder(): Promise<string> {
  const folder = await resolveDeckFolder();
  await mkdir(folder, { recursive: true });
  return folder;
}

/** The deck file's own `mtimeMs` — a single `stat`, not a directory walk: the deck IS the file. Moved here from `slidra/home.ts` ([E6.T2] plan §1) — `home.ts` re-exports it unchanged so `watch.ts`/`save-state.ts` keep importing it from the same place. */
export async function deckFileMtime(deckPath: string): Promise<number> {
  return (await stat(deckPath)).mtimeMs;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
