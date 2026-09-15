// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { copyFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SlidraError, SlidraNotFoundError } from "../slidra/errors.js";
import { runJsonCommand } from "../slidra/command.js";
import {
  isEnoent,
  readProjectsRegistry,
  resolveSlidraHome,
  withProjectsRegistryLock,
  writeProjectsRegistry,
  type SlidraRegistry,
} from "../slidra/home.js";
import { deckFileMtime, ensureDeckFolder } from "./deck-folder.js";
import { moveToTrash } from "./trash.js";

/**
 * `storage/`'s public contract ([E6.T2] plan §7 decision 1): every deck
 * file operation in the codebase goes through this interface — `storage/`
 * is the only place allowed to call `node:fs` against a `.slidra` file's
 * own path. `createLocalDeckStore()` is the one implementation, built once
 * by `startServe` and injected into `open-endpoint.ts`'s routes.
 *
 * Every method here is deliberately deck-session-independent: none of them
 * switch, none of them require a deck to already be open (NOOP-433's
 * `DeckSession` is a `serve.ts`-level concern layered on top — the
 * "renaming/deleting the currently-bound deck" 409 that needs it is checked
 * by the caller in `open-endpoint.ts`, not here).
 */
export interface DeckListEntry {
  fileName: string;
  name: string | null;
  slideCount: number | null;
  owner: string | null;
  /**
   * The registry id this file is already known under, or `null` when it has
   * never been opened/registered — [E6.T4] plan §7 decision 1: listing
   * never mints a new id (`slidra open` is not idempotent — 50 files would
   * mean 50 subprocess spawns and 50 registry entries no card ever uses).
   * When more than one registry entry's `deckPath` resolves to this file,
   * the lexicographically-smallest id wins (plan §4's behavior table) —
   * deterministic, and never mutates the registry to reconcile the
   * duplicates.
   */
  id: string | null;
  /** The deck file's own `mtimeMs` (`deckFileMtime`) — AC2's card metadata and the thumbnail cache's own invalidation key. */
  lastModified: number;
}

export interface CreateDeckInput {
  name?: string;
  owner?: string;
}

export interface CreatedDeck {
  id: string;
  fileName: string;
}

export type ImportDisposition = "move" | "copy";

export interface ImportDeckInput {
  sourcePath: string;
  disposition?: ImportDisposition;
}

/** Thrown by `importExternal` when `sourcePath` is outside the deck folder and no `disposition` was given — AC3's confirmation gate. Nothing is moved/copied before this throws. */
export class ImportConfirmationRequiredError extends Error {
  readonly sourcePath: string;
  constructor(sourcePath: string) {
    super(`the source file is outside the deck folder: ${sourcePath}`);
    this.name = "ImportConfirmationRequiredError";
    this.sourcePath = sourcePath;
  }
}

/** Thrown by `rename` when the target filename already exists — never auto-avoided (the author chose that exact name, unlike `create`/`importExternal`'s own conflict-free naming). */
export class DeckNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeckNameConflictError";
  }
}

/** Thrown by `rename`/`remove` for the id `getCurrentDeckId` reports as currently bound — renaming or deleting a deck file out from under `serve`'s own live session (its watcher, its agent workdir, its editing lock) would corrupt whatever depends on that identity staying put; the caller must switch away first. */
export class DeckBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeckBoundError";
  }
}

export interface DeckStore {
  list(owner?: string): Promise<DeckListEntry[]>;
  create(input: CreateDeckInput): Promise<CreatedDeck>;
  importExternal(input: ImportDeckInput): Promise<CreatedDeck>;
  /** `POST /api/open`'s upload path: raw bytes with no real source path (a browser `<input type="file">` never hands one over). */
  openUpload(bytes: Buffer, displayName: string | undefined): Promise<CreatedDeck>;
  rename(id: string, name: string): Promise<void>;
  /**
   * Renames the deck `id` on disk exactly like `rename`, but WITHOUT the
   * `DeckBoundError` guard — the title bar's own rename flow (`serve.ts`'s
   * `handleRenameCurrentPost`) uses this for the one deck `rename` refuses:
   * whichever deck `DeckSession` currently has bound. Safe there, and only
   * there, because the caller already holds the same guard `switchTo` uses
   * (editing floor idle, no export running) and re-points the file watcher
   * at the new path immediately afterwards — neither of which this method
   * does on its own. Never call this for an id you have not confirmed is
   * the bound one.
   */
  renameBound(id: string, name: string): Promise<{ fileName: string }>;
  /**
   * Re-snapshots `id`'s `savedAt` to its deck file's CURRENT on-disk mtime —
   * for a caller whose own subsequent read against the just-renamed/opened
   * deck (e.g. `DeckSession.refreshCurrent`'s `slidra cat`) may have nudged
   * that mtime forward past a snapshot `rename`/`renameBound` already took
   * earlier in the same request, which would otherwise make the deck read
   * back as dirty for no real edit. A no-op if `id` is not registered.
   */
  resnapshotSaved(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * `POST /api/deck/resolve`'s implementation ([E6.T4] plan §7 decision 1/2):
   * resolves `fileName` (a file already sitting in the deck folder) to its
   * registry id, registering it via `slidra open` only the first time —
   * an already-registered file returns its existing id (the same
   * lexicographically-smallest tie-break `list()` uses) rather than
   * minting a second one and leaving a duplicate registry entry behind.
   * Throws `SlidraNotFoundError` when `fileName` does not name a file in
   * the deck folder.
   */
  resolveId(fileName: string): Promise<CreatedDeck>;
}

export interface DeckStoreOptions {
  /** Resolves the presentation id `serve.ts`'s `DeckSession` currently has bound, if any — omitted (the default) means nothing is ever considered bound, which is what every non-`serve` construction (tests, a future CLI-only caller) wants. */
  getCurrentDeckId?: () => string | null;
}

export function createLocalDeckStore(options: DeckStoreOptions = {}): DeckStore {
  const getCurrentDeckId = options.getCurrentDeckId ?? (() => null);
  return {
    list: listDecks,
    create: createDeck,
    importExternal,
    openUpload,
    rename: (id, name) => renameDeck(getCurrentDeckId, id, name),
    renameBound: (id, name) => applyDeckRename(id, name),
    resnapshotSaved: (id) => resnapshotSavedForId(id),
    remove: (id) => removeDeck(getCurrentDeckId, id),
    resolveId,
  };
}

/** The owner tag every deck gets until an identity claims it — [E6.T9]'s "no identity" state, not just `create`'s default. Literal value is load-bearing: every deck already on disk was written with it, so it must never change. */
export const ANONYMOUS_OWNER = "Anonymous";
const DEFAULT_OWNER = ANONYMOUS_OWNER;

/**
 * The single definition of "anonymous" ([E6.T14r2] Plan §7 decision 1):
 * `owner: null` (never opened/imported-in-place before [E6.T9], or a file
 * whose owner was never written) counts as anonymous the same as the
 * literal `ANONYMOUS_OWNER` tag. Every caller that used to compare against
 * `ANONYMOUS_OWNER` alone (`visibleDecks()`, `claimAnonymous()`) goes
 * through this instead — the Rust CLI's `--owner` filter stays an exact
 * string match and is never asked to express this union.
 */
export function isAnonymousOwner(owner: string | null): boolean {
  return owner === null || owner === ANONYMOUS_OWNER;
}
export const UNTITLED_DECK_NAME = "Untitled";

/** A margin added onto a `saved_at` reading, matching `open-endpoint.ts`'s old `reopenPresentationInPlace` and the Rust registry's own `SAVED_AT_SETTLE_WINDOW_MS` — filesystem timestamp updates can lag the write that triggered them by a few milliseconds. */
const SAVED_AT_SETTLE_WINDOW_MS = 10;

const ILLEGAL_FILESYSTEM_CHAR = /[\\/:*?"<>|\x00-\x1f]/;
const ILLEGAL_FILESYSTEM_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/**
 * A deck's base file name (no `.slidra` extension yet), sanitized for the
 * real filesystem — plan §4's behavior table:
 * - missing/empty/entirely-illegal-character input falls back to `"Untitled"`;
 * - individual illegal characters (including `/`/`\`/NUL) become `_`;
 * - a name that is nothing but dots (`.`, `..`, ...) — the one case the
 *   character-by-character replacement above does not neutralize, since a
 *   bare `..` passed to `path.join` is a parent-directory reference even
 *   with no `/` in it — also becomes all `_`.
 *
 * Never returns anything containing `/`/`\`, so every caller can safely
 * `path.join(deckFolder, sanitizeDeckBaseName(...) + ".slidra")` without
 * ever accepting a caller-supplied path fragment.
 */
export function sanitizeDeckBaseName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) return UNTITLED_DECK_NAME;
  if ([...trimmed].every((ch) => ILLEGAL_FILESYSTEM_CHAR.test(ch))) return UNTITLED_DECK_NAME;
  const sanitized = trimmed.replace(ILLEGAL_FILESYSTEM_CHARS, "_");
  if (/^\.+$/.test(sanitized)) return "_".repeat(sanitized.length);
  return sanitized;
}

/** `<baseName>.slidra` if free, otherwise `<baseName>-1.slidra`, `-2`, … — the first name not already in `existingNames`. Never overwrites, never uses a timestamp (mirrors `crates/slidra/src/asset_import.rs`'s `resolve_conflict_free_filename`). */
export function resolveConflictFreeDeckFileName(baseName: string, existingNames: string[]): string {
  const existing = new Set(existingNames);
  const candidate = `${baseName}.slidra`;
  if (!existing.has(candidate)) return candidate;
  for (let suffix = 1; ; suffix++) {
    const next = `${baseName}-${suffix}.slidra`;
    if (!existing.has(next)) return next;
  }
}

function stripSlidraExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith(".slidra") ? fileName.slice(0, -".slidra".length) : fileName;
}

async function listSlidraFileNames(folder: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return entries.filter((name) => name.toLowerCase().endsWith(".slidra"));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isExdev(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EXDEV";
}

/** Runs `slidra open <deckPath>` to mint a fresh id for a file already sitting at its permanent location — the one registration step every create/import/upload path ends with. */
async function registerDeckAtPath(deckPath: string, fileName?: string): Promise<CreatedDeck> {
  const opened = await runJsonCommand<{ id: string }>(["open", deckPath]);
  if (!opened.ok || typeof opened.data?.id !== "string") {
    throw new SlidraError(opened.message);
  }
  return { id: opened.data.id, fileName: fileName ?? path.basename(deckPath) };
}

/** Raw shape `slidra deck list` itself returns — before this module enriches each entry with `id`/`lastModified`. */
interface RawDeckListEntry {
  fileName: string;
  name: string | null;
  slideCount: number | null;
  owner: string | null;
}

/** One registry read, one reverse index (`deckPath` -> lexicographically-smallest id) — never a per-entry registry scan, so a 50-deck listing stays at exactly one `deck list` subprocess call plus one registry read (AC6, [E6.T4] plan §7 decision 1). */
function buildDeckPathIndex(registry: SlidraRegistry): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, entry] of registry) {
    const resolved = path.resolve(entry.deckPath);
    const existing = index.get(resolved);
    if (existing === undefined || id < existing) index.set(resolved, id);
  }
  return index;
}

async function listDecks(owner?: string): Promise<DeckListEntry[]> {
  const folder = await ensureDeckFolder();
  const args = ["deck", "list", folder];
  if (owner !== undefined) args.push("--owner", owner);
  const result = await runJsonCommand<{ decks: RawDeckListEntry[] }>(args);
  if (!result.ok) {
    if (result.failureKind === "not-found") throw new SlidraNotFoundError(result.message);
    throw new SlidraError(result.message);
  }
  const raw = result.data?.decks ?? [];
  const registry = await readProjectsRegistry();
  const deckPathIndex = buildDeckPathIndex(registry);
  return Promise.all(
    raw.map(async (entry) => {
      const deckPath = path.join(folder, entry.fileName);
      return {
        ...entry,
        id: deckPathIndex.get(path.resolve(deckPath)) ?? null,
        lastModified: await deckFileMtime(deckPath),
      };
    }),
  );
}

/** `POST /api/deck/resolve` ([E6.T4] plan §7 decision 1/2). Never mints a second id for a file already registered — reuses `list()`'s own tie-break so the two never disagree about which id a file "is". */
async function resolveId(fileName: string): Promise<CreatedDeck> {
  const folder = await ensureDeckFolder();
  const deckPath = path.join(folder, fileName);
  if (!(await pathExists(deckPath))) {
    throw new SlidraNotFoundError(`no deck file found: ${fileName}`);
  }
  const registry = await readProjectsRegistry();
  const existingId = buildDeckPathIndex(registry).get(path.resolve(deckPath));
  if (existingId !== undefined) return { id: existingId, fileName };
  return registerDeckAtPath(deckPath, fileName);
}

/**
 * Creates a brand-new deck in the deck folder — AC1, no confirmation of any
 * kind. Order matters (plan §7 decision 7): `new` first, then `deck meta
 * set --owner` (an owner is always resolved, defaulting to `"Anonymous"`),
 * then `open` LAST — opening before the owner write would leave `savedAt`
 * snapshotting the pre-owner-write mtime, so the deck would open already
 * "dirty".
 */
async function createDeck(input: CreateDeckInput): Promise<CreatedDeck> {
  const folder = await ensureDeckFolder();
  const baseName = sanitizeDeckBaseName(input.name);
  const existing = await listSlidraFileNames(folder);
  const fileName = resolveConflictFreeDeckFileName(baseName, existing);
  const targetPath = path.join(folder, fileName);
  const owner = input.owner !== undefined ? input.owner : DEFAULT_OWNER;

  const created = await runJsonCommand(["new", targetPath, "--name", baseName]);
  if (!created.ok) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw new SlidraError(created.message);
  }

  const metaSet = await runJsonCommand(["deck", "meta", "set", targetPath, "--owner", owner]);
  if (!metaSet.ok) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw new SlidraError(metaSet.message);
  }

  try {
    return await registerDeckAtPath(targetPath, fileName);
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Imports an external `.slidra` — AC3. A `sourcePath` already inside the
 * deck folder registers directly, no move/copy, no confirmation, and no
 * owner write — ADR-0023's register-in-place case, a pre-existing file's
 * `owner: null` is never backfilled. Outside the folder with no
 * `disposition` throws `ImportConfirmationRequiredError` before touching
 * anything; `disposition` picks move (source no longer exists afterward) or
 * copy (source untouched) — both write `DEFAULT_OWNER` ([E6.T14r2] Plan §3)
 * but only *after* `registerDeckAtPath`/`open`, deliberately the reverse of
 * `createDeck`'s owner-before-open order: an externally-sourced `.slidra`
 * may still be in the pre-SQLite container format `open` migrates on first
 * read (`deck meta set` has no such migration path and fails outright
 * against one — verified against `e2e`'s own zip-packed fixtures), so
 * `open` has to run first here. `resnapshotSavedAtIfRegistered` afterward
 * re-snapshots `savedAt` past the owner write, the same fix-up `renameDeck`
 * already relies on, so the deck still doesn't open already "dirty".
 */
async function importExternal(input: ImportDeckInput): Promise<CreatedDeck> {
  const folder = await ensureDeckFolder();
  const resolvedSource = path.resolve(input.sourcePath);
  const resolvedFolder = path.resolve(folder);
  const isInside = resolvedSource === resolvedFolder || resolvedSource.startsWith(resolvedFolder + path.sep);

  if (isInside) {
    return registerDeckAtPath(resolvedSource);
  }

  if (input.disposition === undefined) {
    throw new ImportConfirmationRequiredError(resolvedSource);
  }

  const baseName = sanitizeDeckBaseName(stripSlidraExtension(path.basename(resolvedSource)));
  const existing = await listSlidraFileNames(folder);
  const fileName = resolveConflictFreeDeckFileName(baseName, existing);
  const targetPath = path.join(folder, fileName);

  if (input.disposition === "move") {
    try {
      await rename(resolvedSource, targetPath);
    } catch (error) {
      if (isExdev(error)) throw new SlidraError(`cannot move across filesystems: ${resolvedSource}`);
      throw new SlidraError(`failed to move file: ${resolvedSource}`);
    }
  } else {
    await copyFile(resolvedSource, targetPath);
  }

  try {
    const created = await registerDeckAtPath(targetPath, fileName);
    const metaSet = await runJsonCommand(["deck", "meta", "set", targetPath, "--owner", DEFAULT_OWNER]);
    if (!metaSet.ok) throw new SlidraError(metaSet.message);
    await resnapshotSavedAtIfRegistered(targetPath);
    return created;
  } catch (error) {
    if (input.disposition === "move") {
      await rename(targetPath, resolvedSource).catch(() => {});
    } else {
      await rm(targetPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

/** `POST /api/open`'s upload path: writes the uploaded bytes straight into the deck folder under a conflict-free name, validates+registers them the same way `create`/`importExternal` do, then writes `DEFAULT_OWNER` — after `open`, not before, same reason as `importExternal`'s move/copy branch (an uploaded `.slidra` may still be in the pre-SQLite container format only `open` migrates). An invalid upload leaves no file behind. */
async function openUpload(bytes: Buffer, displayName: string | undefined): Promise<CreatedDeck> {
  const folder = await ensureDeckFolder();
  const trimmed = (displayName ?? "").trim();
  const baseName = trimmed.length > 0 ? sanitizeDeckBaseName(stripSlidraExtension(trimmed)) : UNTITLED_DECK_NAME;
  const existing = await listSlidraFileNames(folder);
  const fileName = resolveConflictFreeDeckFileName(baseName, existing);
  const targetPath = path.join(folder, fileName);

  await writeFile(targetPath, bytes);
  try {
    const created = await registerDeckAtPath(targetPath, fileName);
    const metaSet = await runJsonCommand(["deck", "meta", "set", targetPath, "--owner", DEFAULT_OWNER]);
    if (!metaSet.ok) throw new SlidraError(metaSet.message);
    await resnapshotSavedAtIfRegistered(targetPath);
    return created;
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Renames a registered deck's file on disk — AC5. The target name is
 * never auto-avoided (unlike `create`/`importExternal`): a conflict is a
 * 409, since the author asked for that exact name. Stays in the deck's
 * existing directory (changing `deckFolder` only affects where *future*
 * decks land, AC2). `project.json`'s `name` field is synced to match, and
 * `savedAt` is re-snapshotted after that write so the deck does not open
 * already "dirty".
 */
async function renameDeck(getCurrentDeckId: () => string | null, id: string, name: string): Promise<void> {
  if (getCurrentDeckId() === id) {
    throw new DeckBoundError(`cannot rename the deck that is currently open: ${id}`);
  }
  await applyDeckRename(id, name);
}

/** The on-disk rename shared by `renameDeck` (guarded) and `DeckStore.renameBound` (unguarded) — see the latter's docstring for why an unguarded path exists at all. */
async function applyDeckRename(id: string, name: string): Promise<{ fileName: string }> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) throw new SlidraNotFoundError(`no presentation found for id: ${id}`);

  const baseName = sanitizeDeckBaseName(name);
  const newFileName = `${baseName}.slidra`;
  const newPath = path.join(path.dirname(entry.deckPath), newFileName);

  if (newPath !== entry.deckPath) {
    if (await pathExists(newPath)) {
      throw new DeckNameConflictError(`a deck named ${newFileName} already exists`);
    }
    try {
      await rename(entry.deckPath, newPath);
    } catch {
      throw new SlidraError(`failed to rename deck file: ${entry.deckPath}`);
    }
  }

  const metaSet = await runJsonCommand(["deck", "meta", "set", newPath, "--name", baseName]);
  if (!metaSet.ok) {
    throw new SlidraError(metaSet.message);
  }

  const savedAt = (await deckFileMtime(newPath)) + SAVED_AT_SETTLE_WINDOW_MS;
  await withProjectsRegistryLock(async () => {
    const latest = await readProjectsRegistry();
    const current = latest.get(id);
    if (!current) return;
    latest.set(id, { ...current, deckPath: newPath, sourcePath: newPath, savedAt });
    await writeProjectsRegistry(latest);
  });
  return { fileName: newFileName };
}

/**
 * Re-snapshots a claimed deck's `savedAt` the same way `renameDeck` does
 * above (`:343-350`) — after a `deck meta set --owner` write, the registry
 * entry's old `savedAt` would read stale and the deck would open already
 * "dirty" ([E6.T9] plan §3). A deck never opened yet has no registry entry
 * at all; that is not an error, there is simply nothing to re-snapshot.
 */
async function resnapshotSavedForId(id: string): Promise<void> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) return;
  await resnapshotSavedAtIfRegistered(entry.deckPath);
}

async function resnapshotSavedAtIfRegistered(deckPath: string): Promise<void> {
  const registry = await readProjectsRegistry();
  const match = [...registry].find(([, entry]) => entry.deckPath === deckPath);
  if (!match) return;
  const [id] = match;
  const savedAt = (await deckFileMtime(deckPath)) + SAVED_AT_SETTLE_WINDOW_MS;
  await withProjectsRegistryLock(async () => {
    const latest = await readProjectsRegistry();
    const current = latest.get(id);
    if (!current) return;
    latest.set(id, { ...current, savedAt });
    await writeProjectsRegistry(latest);
  });
}

/**
 * Reassigns every currently-anonymous deck (`isAnonymousOwner` — the
 * literal `ANONYMOUS_OWNER` tag or `owner: null`) to `ownerTag` — the
 * "claim" side effect of signing in ([E6.T9] plan §7 decision 5, widened by
 * [E6.T14r2] Plan §7 decision 3). Order is
 * deliberately per-file, not batched: a failure partway through leaves the
 * decks already reassigned exactly as reassigned (their content never
 * touched — `deck meta set --owner` only ever rewrites `project.json`'s
 * owner key, `crates/…/deck.rs:275-282`), and the thrown message names the
 * first file that failed so the caller/UI can say which one. `identity/`
 * itself never touches `node:fs` — this is the one place that does the
 * reassignment, same rule as every other deck file mutation in this repo.
 */
export async function claimAnonymous(ownerTag: string): Promise<number> {
  const folder = await ensureDeckFolder();
  const anonymous = (await listDecks()).filter((entry) => isAnonymousOwner(entry.owner));
  let claimed = 0;
  for (const entry of anonymous) {
    const deckPath = path.join(folder, entry.fileName);
    const metaSet = await runJsonCommand(["deck", "meta", "set", deckPath, "--owner", ownerTag]);
    if (!metaSet.ok) {
      throw new SlidraError(`failed to claim ${entry.fileName}: ${metaSet.message}`);
    }
    await resnapshotSavedAtIfRegistered(deckPath);
    claimed++;
  }
  return claimed;
}

/** Deletes a registered deck: moves its file to the OS trash (AC4, never a bare `unlink`), then drops its registry entry, history, and clipboard. */
async function removeDeck(getCurrentDeckId: () => string | null, id: string): Promise<void> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) throw new SlidraNotFoundError(`no presentation found for id: ${id}`);
  if (getCurrentDeckId() === id) {
    throw new DeckBoundError(`cannot delete the deck that is currently open: ${id}`);
  }

  await moveToTrash(entry.deckPath);

  await withProjectsRegistryLock(async () => {
    const latest = await readProjectsRegistry();
    latest.delete(id);
    await writeProjectsRegistry(latest);
  });

  const home = resolveSlidraHome();
  await rm(path.join(home, "history", id), { recursive: true, force: true }).catch(() => {});
  await rm(path.join(home, "clipboard", `${id}.json`), { force: true }).catch(() => {});
}
