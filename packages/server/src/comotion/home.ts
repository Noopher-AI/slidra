import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError, CoMotionNotFoundError } from "./errors.js";

/**
 * `packages/server`'s own reader for `<CO_MOTION_HOME>/projects.json` —
 * the one file this server and the Rust `co-motion` binary both read and
 * write ([E4.T9]/F7, plan §7 decision 10). Every other piece of a
 * presentation's content goes through the binary; this file (and
 * `history/<id>/stack.json`, see `history-group.ts`) is the one place the
 * server still touches `CO_MOTION_HOME` directly, because there is no CLI
 * command that exposes an id's real work directory or the save-state bookkeeping.
 *
 * The shape mirrors `packages/core/src/workspace.ts`'s `RegistryEntry`
 * exactly — the two must never drift, since they read and write the exact
 * same file.
 */
export interface CoMotionRegistryEntry {
  workDir: string;
  /** The `.comot` path `open`/`co-motion open` last read from. */
  sourcePath?: string;
  /** `maxMtimeInDirectory`'s reading at the last moment the work directory is known to match `sourcePath` byte-for-byte — see `readSaveState`. */
  savedAt?: number;
}

export type CoMotionRegistry = Map<string, CoMotionRegistryEntry>;

/** Resolves CO_MOTION_HOME, defaulting to ~/.comotion. Read fresh on every call (not cached) so tests can point it at a temp directory per test. */
export function resolveCoMotionHome(): string {
  return process.env.CO_MOTION_HOME ?? path.join(homedir(), ".comotion");
}

function registryPath(home: string): string {
  return path.join(home, "projects.json");
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRegistryEntry(value: unknown): value is CoMotionRegistryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "workDir" in value &&
    typeof (value as { workDir: unknown }).workDir === "string"
  );
}

/**
 * Reads and parses `projects.json`. Only a genuinely missing file is an
 * empty registry — every other failure (malformed JSON, a malformed entry,
 * permission denied) is an explicit `CoMotionError`, never a silent
 * fallback to empty.
 */
export async function readProjectsRegistry(): Promise<CoMotionRegistry> {
  const home = resolveCoMotionHome();
  let raw: string;
  try {
    raw = await readFile(registryPath(home), "utf-8");
  } catch (error) {
    if (isEnoent(error)) {
      return new Map();
    }
    throw new CoMotionError("無法讀取簡報登記資料");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError("簡報登記資料已損毀");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CoMotionError("簡報登記資料已損毀");
  }

  const registry: CoMotionRegistry = new Map();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isRegistryEntry(value)) {
      throw new CoMotionError(`簡報登記資料已損毀：${id}`);
    }
    registry.set(id, value);
  }
  return registry;
}

/**
 * Writes `projects.json` atomically: temp file + `rename`, so a crash or a
 * full disk mid-write can never leave it truncated or half-written.
 */
export async function writeProjectsRegistry(registry: CoMotionRegistry): Promise<void> {
  const home = resolveCoMotionHome();
  await mkdir(home, { recursive: true });
  const serialized = Object.fromEntries(registry);
  const finalPath = registryPath(home);
  const tempPath = path.join(home, `.projects.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(serialized, null, 2)}\n`);
    await rename(tempPath, finalPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new CoMotionError("無法寫入簡報登記資料");
  }
}

/**
 * Resolves an opaque presentation id to its real work directory — the one
 * id-to-path lookup this module offers. An unknown id throws
 * `CoMotionNotFoundError`, the same wording `co-motion`'s own commands use.
 */
export async function workDirFor(id: string): Promise<string> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) {
    throw new CoMotionNotFoundError(`找不到識別碼對應的簡報：${id}`);
  }
  return entry.workDir;
}

/** The newest `mtimeMs` of `dir` itself or anything nested inside it. */
export async function maxMtimeInDirectory(dir: string): Promise<number> {
  let max = (await stat(dir)).mtimeMs;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, await maxMtimeInDirectory(fullPath));
    } else if (entry.isFile()) {
      max = Math.max(max, (await stat(fullPath)).mtimeMs);
    }
  }
  return max;
}
