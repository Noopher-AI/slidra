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
  remove(id: string): Promise<void>;
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
    remove: (id) => removeDeck(getCurrentDeckId, id),
  };
}

const DEFAULT_OWNER = "Anonymous";
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

async function listDecks(owner?: string): Promise<DeckListEntry[]> {
  const folder = await ensureDeckFolder();
  const args = ["deck", "list", folder];
  if (owner !== undefined) args.push("--owner", owner);
  const result = await runJsonCommand<{ decks: DeckListEntry[] }>(args);
  if (!result.ok) {
    if (result.failureKind === "not-found") throw new SlidraNotFoundError(result.message);
    throw new SlidraError(result.message);
  }
  return result.data?.decks ?? [];
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
 * deck folder registers directly, no move/copy, no confirmation. Outside
 * the folder with no `disposition` throws `ImportConfirmationRequiredError`
 * before touching anything; `disposition` picks move (source no longer
 * exists afterward) or copy (source untouched).
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
    return await registerDeckAtPath(targetPath, fileName);
  } catch (error) {
    if (input.disposition === "move") {
      await rename(targetPath, resolvedSource).catch(() => {});
    } else {
      await rm(targetPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

/** `POST /api/open`'s upload path: writes the uploaded bytes straight into the deck folder under a conflict-free name, then validates+registers them the same way `create`/`importExternal` do — an invalid upload leaves no file behind. */
async function openUpload(bytes: Buffer, displayName: string | undefined): Promise<CreatedDeck> {
  const folder = await ensureDeckFolder();
  const trimmed = (displayName ?? "").trim();
  const baseName = trimmed.length > 0 ? sanitizeDeckBaseName(stripSlidraExtension(trimmed)) : UNTITLED_DECK_NAME;
  const existing = await listSlidraFileNames(folder);
  const fileName = resolveConflictFreeDeckFileName(baseName, existing);
  const targetPath = path.join(folder, fileName);

  await writeFile(targetPath, bytes);
  try {
    return await registerDeckAtPath(targetPath, fileName);
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
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) throw new SlidraNotFoundError(`no presentation found for id: ${id}`);
  if (getCurrentDeckId() === id) {
    throw new DeckBoundError(`cannot rename the deck that is currently open: ${id}`);
  }

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
