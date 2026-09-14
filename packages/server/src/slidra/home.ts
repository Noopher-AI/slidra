// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { SlidraError, SlidraNotFoundError } from "./errors.js";
import { deckFileMtime } from "../storage/deck-folder.js";

export { deckFileMtime };

/**
 * `packages/server`'s own reader for `<SLIDRA_HOME>/projects.json` —
 * the one file this server and the Rust `slidra` binary both read and
 * write ([E4.T9]/F7, plan §7 decision 10). Every other piece of a
 * presentation's content goes through the binary; this file (and
 * see `history-group.ts`) is the one place the
 * server still touches `SLIDRA_HOME` directly, because there is no CLI
 * command that exposes an id's real deck path or the save-state bookkeeping.
 *
 * The shape mirrors the Rust crate's `workspace::registry::RegistryEntry`
 * exactly — the two must never drift, since they read and write the exact
 * same file. A presentation id resolves to the `.slidra` deck FILE itself
 * now (`spec/rfcs/0001-sqlite-container-format.md`) — there is no separate
 * work directory any more.
 */
export interface SlidraRegistryEntry {
  deckPath: string;
  /** The `.slidra` path `open`/`slidra open` last read from. */
  sourcePath?: string;
  /** The deck file's own mtime at the last moment it is known to match `sourcePath` byte-for-byte — see `readSaveState`. */
  savedAt?: number;
}

export type SlidraRegistry = Map<string, SlidraRegistryEntry>;

/** Resolves SLIDRA_HOME, defaulting to ~/.slidra. Read fresh on every call (not cached) so tests can point it at a temp directory per test. */
export function resolveSlidraHome(): string {
  return process.env.SLIDRA_HOME ?? path.join(homedir(), ".slidra");
}

function registryPath(home: string): string {
  return path.join(home, "projects.json");
}

/** True for the `fs` failure an exclusive-create hits when somebody else already holds the lock. */
function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** True for the one `fs` failure that routinely means "nothing there yet" rather than a real problem. */
export function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRegistryEntry(value: unknown): value is SlidraRegistryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "deckPath" in value &&
    typeof (value as { deckPath: unknown }).deckPath === "string"
  );
}

/**
 * A pre-upgrade entry written before `deckPath` replaced `workDir`
 * (`spec/rfcs/0001-sqlite-container-format.md`). Its own id is already
 * dead — `<SLIDRA_HOME>/work/<id>/` no longer exists — so it is dropped
 * on read rather than aborting the whole registry, mirroring the Rust
 * crate's `read_registry`.
 */
function isLegacyWorkDirEntry(value: unknown): boolean {
  return typeof value === "object" && value !== null && "workDir" in value;
}

/**
 * Reads and parses `projects.json`. Only a genuinely missing file is an
 * empty registry — every other failure (malformed JSON, a malformed entry,
 * permission denied) is an explicit `SlidraError`, never a silent
 * fallback to empty.
 */
export async function readProjectsRegistry(): Promise<SlidraRegistry> {
  const home = resolveSlidraHome();
  let raw: string;
  try {
    raw = await readFile(registryPath(home), "utf-8");
  } catch (error) {
    if (isEnoent(error)) {
      return new Map();
    }
    throw new SlidraError("failed to read presentation registry data");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SlidraError("presentation registry data is corrupted");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SlidraError("presentation registry data is corrupted");
  }

  const registry: SlidraRegistry = new Map();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isRegistryEntry(value)) {
      if (isLegacyWorkDirEntry(value)) {
        continue;
      }
      throw new SlidraError(`presentation registry data is corrupted: ${id}`);
    }
    registry.set(id, value);
  }
  return registry;
}

/**
 * The advisory lock guarding a `projects.json` read-modify-write. Its name
 * is shared verbatim with the Rust crate's `registry_lock_path`
 * (`crates/slidra/src/workspace/mod.rs`) — the two must never drift,
 * since a lock only excludes anybody at all if every writer agrees on the
 * path.
 */
function registryLockPath(home: string): string {
  return path.join(home, ".projects.json.lock");
}

/** How long to keep trying before giving up on acquiring the lock. */
const LOCK_TIMEOUT_MS = 5_000;

/** A lock file untouched for this long belonged to a process that died before releasing it, and is stolen. Far longer than any real read-modify-write of this file takes. */
const LOCK_STALE_AFTER_MS = 30_000;

/** How long to wait between acquisition attempts. */
const LOCK_RETRY_INTERVAL_MS = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when `lockPath` exists and has not been touched for `LOCK_STALE_AFTER_MS`. */
async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockPath);
    return Date.now() - mtimeMs > LOCK_STALE_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Runs `body` while holding the `projects.json` advisory lock, so a
 * read-modify-write of the registry cannot interleave with another
 * process's.
 *
 * `projects.json` is the one file this server and the Rust `slidra`
 * binary both write, and every writer reads the whole map, changes one
 * entry and writes the whole map back. Both sides write through a temp
 * file + `rename`, so the file is never *torn* — but that says nothing
 * about lost updates: two writers that each read the same map and write it
 * back in turn leave only the second one's change, silently dropping a
 * work directory that no id reaches any more.
 *
 * `body` must never shell out to a `slidra` command — the CLI takes
 * this same lock for its own registry writes, and would deadlock against
 * this one.
 *
 * The lock is an exclusive-create of a lock file: portable, dependency
 * free, and released by unlinking. A process that dies while holding it
 * leaves the file behind, so a lock nobody has touched for
 * `LOCK_STALE_AFTER_MS` is stolen rather than waited on forever.
 */
export async function withProjectsRegistryLock<T>(body: () => Promise<T>): Promise<T> {
  const home = resolveSlidraHome();
  await mkdir(home, { recursive: true });
  const lockPath = registryLockPath(home);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (!isEexist(error)) throw new SlidraError("failed to write presentation registry data");
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SlidraError("another slidra is writing presentation registry data, please try again later");
      }
      await sleep(LOCK_RETRY_INTERVAL_MS);
      continue;
    }
    await handle.close();
    try {
      return await body();
    } finally {
      // Released on every path out of `body`, including a throw — a leaked
      // lock file would block every later writer for `LOCK_STALE_AFTER_MS`.
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * Writes `projects.json` atomically: temp file + `rename`, so a crash or a
 * full disk mid-write can never leave it truncated or half-written.
 *
 * Atomic against a *torn* file, not against a lost update — wrap the
 * surrounding read-modify-write in `withProjectsRegistryLock` for that.
 */
export async function writeProjectsRegistry(registry: SlidraRegistry): Promise<void> {
  const home = resolveSlidraHome();
  await mkdir(home, { recursive: true });
  const serialized = Object.fromEntries(registry);
  const finalPath = registryPath(home);
  const tempPath = path.join(home, `.projects.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(serialized, null, 2)}\n`);
    await rename(tempPath, finalPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new SlidraError("failed to write presentation registry data");
  }
}

/**
 * Resolves an opaque presentation id to its real deck file path — the one
 * id-to-path lookup this module offers. An unknown id throws
 * `SlidraNotFoundError`, the same wording `slidra`'s own commands use.
 */
export async function deckPathFor(id: string): Promise<string> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) {
    throw new SlidraNotFoundError(`no presentation found for id: ${id}`);
  }
  return entry.deckPath;
}
