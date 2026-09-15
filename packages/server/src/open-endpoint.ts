// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { IncomingMessage, ServerResponse } from "node:http";
import { SlidraError, SlidraNotFoundError } from "./slidra/errors.js";
import {
  DeckBoundError,
  DeckNameConflictError,
  ImportConfirmationRequiredError,
  type DeckListEntry,
  type DeckStore,
} from "./storage/deck-store.js";
import { getOrCreateThumbnail, ThumbnailNoSlidesError, ThumbnailNotFoundError } from "./storage/thumbnail-cache.js";

/**
 * The deck lifecycle HTTP routes ([E6.T2], NOOP-448): `POST /api/new`,
 * `POST /api/open`, `POST /api/deck/import`, `POST /api/deck/rename`,
 * `POST /api/deck/delete`, `GET /api/decks`. Every one of these is
 * deck-session-independent (NOOP-433's `DeckSession`/`requireDeck` play no
 * part here) — they create/import/list/rename/delete a deck FILE, never
 * the presentation this `serve` process happens to be showing right now.
 *
 * This supersedes this module's previous "reopen the currently-bound
 * presentation in place" behavior entirely: `POST /api/new`/`POST /api/open`
 * used to swap the served presentation's own content out from under it
 * (`reopenPresentationInPlace`, staged under `<SLIDRA_HOME>/opened/<opaque>/`).
 * A newly created or opened deck now lands directly in the configured deck
 * folder (AC1) and is handed back as its own `{id, fileName}` — nothing
 * about the currently-served presentation changes, and nothing switches to
 * it, until a caller explicitly does that through `POST /api/deck/switch`
 * ([E6.T4]'s job, not this one).
 *
 * Every deck file operation here goes through `storage/`'s `DeckStore` — no
 * `node:fs` import in this file at all (AC7's mechanical check:
 * `rg -n "node:fs" packages/server/src --glob '!storage/**'`).
 */

const FILE_NAME_HEADER = "x-slidra-file-name";
/** Same order-of-magnitude headroom as asset-upload.ts's own limit, halved: a `.slidra` with no large embedded media is far smaller than this; a bigger one should go through the CLI instead. */
const MAX_OPEN_BODY_BYTES = 16 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

/** Same shape as asset-upload.ts's own `readLimitedBinaryBody` — binary, size-capped, never destroys the socket on overflow so a 400 can still reach the client. */
function readLimitedBinaryBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Maps a `DeckStore` rejection to its HTTP shape — the one place every route below translates a thrown error, so the mapping cannot drift between them. */
function sendStoreError(res: ServerResponse, error: unknown, fallbackMessage: string): void {
  if (error instanceof ImportConfirmationRequiredError) {
    sendJson(res, 409, { error: error.message, reason: "confirm-import", sourcePath: error.sourcePath });
    return;
  }
  if (error instanceof DeckNameConflictError) {
    sendJson(res, 409, { error: error.message, reason: "name-conflict" });
    return;
  }
  if (error instanceof DeckBoundError) {
    sendJson(res, 409, { error: error.message, reason: "deck-bound" });
    return;
  }
  if (error instanceof SlidraNotFoundError) {
    sendJson(res, 404, { error: error.message });
    return;
  }
  if (error instanceof SlidraError) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : fallbackMessage });
}

/** `POST /api/new` — the GUI's New action: creates a brand-new, no-slides deck in the deck folder (AC1). Body: `{ name?: string, owner?: string }`. */
export async function handleNewPost(store: DeckStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    const raw = await readTextBody(req);
    parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "Request body must be a JSON object" });
    return;
  }
  const { name, owner } = parsed as { name?: unknown; owner?: unknown };
  if (name !== undefined && typeof name !== "string") {
    sendJson(res, 400, { error: "name must be a string" });
    return;
  }
  if (owner !== undefined && typeof owner !== "string") {
    sendJson(res, 400, { error: "owner must be a string" });
    return;
  }

  try {
    const created = await store.create({ name, owner });
    sendJson(res, 200, { ok: true, id: created.id, fileName: created.fileName });
  } catch (error) {
    sendStoreError(res, error, "Create failed");
  }
}

/**
 * `POST /api/open` — the GUI's Open action. A browser's `<input
 * type="file">` only ever hands over bytes, never a real filesystem path,
 * so this keeps its existing raw-body + `x-slidra-file-name` header shape
 * (the same one `POST /api/asset` uses) rather than becoming a `sourcePath`
 * import. The uploaded bytes are written straight into the deck folder
 * (AC1) under a conflict-free name, then validated by registering them the
 * same way `create`/`deck/import` do — an invalid upload leaves no file
 * behind.
 */
export async function handleOpenPost(store: DeckStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fileNameHeader = req.headers[FILE_NAME_HEADER];
  let displayName: string | undefined;
  if (typeof fileNameHeader === "string" && fileNameHeader.trim() !== "") {
    try {
      displayName = decodeURIComponent(fileNameHeader);
    } catch {
      sendJson(res, 400, { error: `Invalid header encoding: ${FILE_NAME_HEADER}` });
      return;
    }
  }

  let body: Buffer;
  try {
    body = await readLimitedBinaryBody(req, MAX_OPEN_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 400, { error: "Presentation file too large" });
      return;
    }
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: "No file content received" });
    return;
  }

  try {
    const created = await store.openUpload(body, displayName);
    sendJson(res, 200, { ok: true, id: created.id, fileName: created.fileName });
  } catch (error) {
    sendStoreError(res, error, "Open failed");
  }
}

/** `POST /api/deck/import` — brings an external `.slidra` into the deck folder (AC3). Body: `{ sourcePath: string, disposition?: "move" | "copy" }`. */
export async function handleImportPost(store: DeckStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    sourcePath?: unknown;
    disposition?: unknown;
  };
  if (typeof body.sourcePath !== "string" || body.sourcePath === "") {
    sendJson(res, 400, { error: "sourcePath must be a non-empty string" });
    return;
  }
  if (body.disposition !== undefined && body.disposition !== "move" && body.disposition !== "copy") {
    sendJson(res, 400, { error: 'disposition must be "move" or "copy"' });
    return;
  }

  try {
    const created = await store.importExternal({ sourcePath: body.sourcePath, disposition: body.disposition });
    sendJson(res, 200, { ok: true, id: created.id, fileName: created.fileName });
  } catch (error) {
    sendStoreError(res, error, "Import failed");
  }
}

/** `POST /api/deck/rename` — AC5. Body: `{ id: string, name: string }`. Refuses with 409 `{reason:"deck-bound"}` for the currently-open deck (the store's own `getCurrentDeckId` check) without touching any file. */
export async function handleRenamePost(store: DeckStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { id?: unknown; name?: unknown };
  if (typeof body.id !== "string" || body.id === "") {
    sendJson(res, 400, { error: "id must be a non-empty string" });
    return;
  }
  if (typeof body.name !== "string" || body.name === "") {
    sendJson(res, 400, { error: "name must be a non-empty string" });
    return;
  }

  try {
    await store.rename(body.id, body.name);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendStoreError(res, error, "Rename failed");
  }
}

/** `POST /api/deck/delete` — AC4. Body: `{ id: string }`. Refuses with 409 `{reason:"deck-bound"}` for the currently-open deck (the store's own `getCurrentDeckId` check) without touching any file. */
export async function handleDeletePost(store: DeckStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const id = typeof parsed === "object" && parsed !== null ? (parsed as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id === "") {
    sendJson(res, 400, { error: "id must be a non-empty string" });
    return;
  }

  try {
    await store.remove(id);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendStoreError(res, error, "Delete failed");
  }
}

/**
 * `GET /api/decks?owner=` — AC6. Every entry is scanned directly out of the
 * deck folder (`storage/`'s one Rust subprocess call), never out of the
 * registry — a deck that has never been opened still shows up here.
 *
 * `resolveVisibleDecks` is [E6.T9]'s optional identity-aware seam: an
 * explicit `?owner=` always wins and bypasses it entirely (identity never
 * overrides a caller-specified filter), matching T2's original contract
 * unchanged — this is what keeps `deck-storage.test.ts:372`'s three-arg
 * call passing with no edit. Omitted (every caller before [E6.T9]),
 * `store.list(undefined)` runs exactly as it always did.
 */
export async function handleDecksGet(
  store: DeckStore,
  url: URL,
  res: ServerResponse,
  resolveVisibleDecks?: () => Promise<DeckListEntry[]>,
): Promise<void> {
  const hasOwnerParam = url.searchParams.has("owner");
  const owner = hasOwnerParam ? (url.searchParams.get("owner") ?? "") : undefined;
  try {
    const decks = hasOwnerParam || !resolveVisibleDecks ? await store.list(owner) : await resolveVisibleDecks();
    sendJson(res, 200, { decks });
  } catch (error) {
    sendStoreError(res, error, "Failed to list decks");
  }
}

/** A deck folder entry's own file name — never a path fragment: no separator, no `..`, matching `sanitizeDeckBaseName`'s own never-produces-a-separator guarantee for anything this route needs to accept back. */
function isValidDeckFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

/** `POST /api/deck/resolve` — Deck Space's lazy registration ([E6.T4] plan §7 decision 1/2). Body: `{ fileName: string }`. Deck-independent, like the routes above: never touches whichever deck this server currently has open. */
export async function handleResolvePost(store: DeckStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "Request body must be a JSON object" });
    return;
  }
  const fileName = (parsed as { fileName?: unknown }).fileName;
  if (!isValidDeckFileName(fileName)) {
    sendJson(res, 400, { error: "fileName must be a non-empty file name with no path separators" });
    return;
  }

  try {
    const resolved = await store.resolveId(fileName);
    sendJson(res, 200, { id: resolved.id, fileName: resolved.fileName });
  } catch (error) {
    sendStoreError(res, error, "Resolve failed");
  }
}

/** `GET /api/decks/thumbnail?fileName=&v=` — a lazily-registered, cache-first first-slide render (AC2/AC6). `v` (the card's `lastModified`) is a browser cache-buster only; the route derives its own truth from the deck file's real mtime, never trusts the query value. */
export async function handleThumbnailGet(store: DeckStore, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fileName = url.searchParams.get("fileName");
  if (!isValidDeckFileName(fileName)) {
    sendJson(res, 400, { error: "fileName must be a non-empty file name with no path separators" });
    return;
  }

  try {
    const { bytes, etag } = await getOrCreateThumbnail(store, fileName);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      ETag: etag,
      "Content-Length": String(bytes.byteLength),
    });
    res.end(bytes);
  } catch (error) {
    if (error instanceof ThumbnailNotFoundError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    if (error instanceof ThumbnailNoSlidesError) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to render thumbnail" });
  }
}
