// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * `DeckSpace`'s own fetch layer — every request the deck-selection screen
 * makes, in one place, same "throw on a load failure, return a typed result
 * on a mutation" split `presentation.ts` uses ([E6.T4] plan §6: "the public
 * boundary is HTTP routes' request/response", never `App.tsx`'s own
 * `fetch` calls duplicated here).
 */

export interface DeckSummary {
  fileName: string;
  name: string | null;
  slideCount: number | null;
  owner: string | null;
  /** `null` when this file has never been opened/registered — resolved lazily via `resolveDeckId` only when the user actually acts on the card. */
  id: string | null;
  lastModified: number;
}

export interface DeckIdentity {
  id: string;
  name: string | null;
  fileName: string | null;
}

/** A failed mutation — `reason` is only present for a 409 (`"deck-bound"` / `"name-conflict"` / `"editing"` / `"exporting"`); every other failure is a plain `error` string. */
export interface DeckApiError {
  ok: false;
  status: number;
  error: string;
  reason?: string;
}

export type DeckApiResult<T> = ({ ok: true } & T) | DeckApiError;

async function parseError(response: Response): Promise<DeckApiError> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
  return {
    ok: false,
    status: response.status,
    error: typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  };
}

/** Non-2xx throws — a failed listing is "Deck Space cannot render at all", not a per-action result. */
export async function fetchDecks(): Promise<DeckSummary[]> {
  const response = await fetch("/api/decks");
  if (!response.ok) throw new Error("Failed to load: /api/decks");
  const data = (await response.json()) as { decks: DeckSummary[] };
  return data.decks;
}

/** Non-2xx throws, same reasoning as `fetchDecks`. */
export async function fetchCurrentDeck(): Promise<DeckIdentity | null> {
  const response = await fetch("/api/deck");
  if (!response.ok) throw new Error("Failed to load: /api/deck");
  const data = (await response.json()) as { deck: DeckIdentity | null };
  return data.deck;
}

export async function resolveDeckId(fileName: string): Promise<DeckApiResult<{ id: string; fileName: string }>> {
  const response = await fetch("/api/deck/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName }),
  });
  if (!response.ok) return parseError(response);
  return { ok: true, ...(await response.json()) };
}

export async function switchToDeck(id: string): Promise<DeckApiResult<{ switched: boolean; deck: DeckIdentity }>> {
  const response = await fetch("/api/deck/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) return parseError(response);
  return { ok: true, ...(await response.json()) };
}

export async function createDeck(name?: string): Promise<DeckApiResult<{ id: string; fileName: string }>> {
  const response = await fetch("/api/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name !== undefined ? { name } : {}),
  });
  if (!response.ok) return parseError(response);
  return { ok: true, ...(await response.json()) };
}

/** `POST /api/open` — the Open-external-file path (button picker and drag-and-drop both hand over a `File`, never a real filesystem path from the browser). */
export async function openDeckFile(file: File): Promise<DeckApiResult<{ id: string; fileName: string }>> {
  const bytes = await file.arrayBuffer();
  const response = await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "x-slidra-file-name": encodeURIComponent(file.name) },
    body: bytes,
  });
  if (!response.ok) return parseError(response);
  return { ok: true, ...(await response.json()) };
}

export async function renameDeck(id: string, name: string): Promise<DeckApiResult<object>> {
  const response = await fetch("/api/deck/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  if (!response.ok) return parseError(response);
  return { ok: true };
}

/**
 * `POST /api/deck/rename-current` — the title bar's own rename, for the one
 * deck `renameDeck` above always refuses: whichever deck this server
 * currently has bound. `reason` on a 409 is `"no-deck"` / `"editing"` /
 * `"exporting"` / `"name-conflict"`, never `"deck-bound"` (that reason only
 * ever comes from `renameDeck`).
 */
export async function renameCurrentDeck(name: string): Promise<DeckApiResult<{ fileName: string }>> {
  const response = await fetch("/api/deck/rename-current", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) return parseError(response);
  return { ok: true, ...(await response.json()) };
}

export async function deleteDeck(id: string): Promise<DeckApiResult<object>> {
  const response = await fetch("/api/deck/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) return parseError(response);
  return { ok: true };
}

/** `v` is a browser cache-buster only (the server derives its own truth from the deck file's real mtime) — bumping `lastModified` after a rename/edit ensures the `<img>` doesn't keep showing a stale cached bitmap under the old URL. */
export function thumbnailUrl(fileName: string, lastModified: number): string {
  return `/api/decks/thumbnail?fileName=${encodeURIComponent(fileName)}&v=${lastModified}`;
}
