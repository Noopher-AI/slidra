// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useState } from "react";
import { App } from "./App.js";
import { DeckSpace } from "./shell/deck-space/DeckSpace.js";
import {
  createDeck,
  deleteDeck,
  fetchCurrentDeck,
  fetchDecks,
  openDeckFile,
  renameDeck,
  resolveDeckId,
  switchToDeck,
  type DeckIdentity,
  type DeckSummary,
} from "./shell/deck-space/deck-api.js";
import { useIdentity } from "./shell/user-block/use-identity.js";
import type { UserBlockProps } from "./shell/user-block/UserBlock.js";

/**
 * [E6.T4] plan §7 decision 3: the one place that decides deck vs. editor,
 * AND the one place every deck-lifecycle fetch/mutation lives — `DeckSpace`
 * itself is deliberately presentational (props in, markup out), so this is
 * where `GET /api/decks`, new/open/rename/delete/enter are all wired up.
 *
 * `app/page.tsx` renders this instead of `<App>` directly. `GET /api/deck`
 * on mount decides the startup screen (AC1): no deck bound renders only
 * `<DeckSpace>`, full screen, no way to close it (there is no editor to
 * return to yet); a bound deck renders `<App key={deck.id}>` and lets Deck
 * Space toggle as an overlay on top of it via the title bar's own button.
 *
 * `key={deck.id}` on `<App>` is deliberate (plan §7 decision 3): entering a
 * different deck remounts the whole editor rather than auditing App.tsx's
 * ~30 effects for "does this reset itself on a deck change" one by one.
 *
 * [E6.T14r2] Plan §7 decision 4: this is also the one place `useIdentity()`
 * is called — no deck bound means `<App>` never mounts, yet Deck Space's
 * own user block still needs live identity state, so the hook has to live
 * above both rather than inside `<App>` (which used to own it, [E6.T9]).
 */
export function Workspace() {
  const [deck, setDeck] = useState<DeckIdentity | null | "loading">("loading");
  const [deckSpaceOpen, setDeckSpaceOpen] = useState(false);
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const identity = useIdentity();
  const userBlock: UserBlockProps = {
    identity: identity.identity,
    providers: identity.providers,
    pending: identity.pending,
    message: identity.message,
    onSignIn: identity.signIn,
    onSignOut: identity.signOut,
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentDeck();
        if (!cancelled) setDeck(current);
      } catch {
        // No deck info at all (network/server failure at startup) — treat
        // the same as "no deck bound" so Deck Space is at least reachable
        // rather than the app hanging on a permanent loading state.
        if (!cancelled) setDeck(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function reloadDecks(): Promise<void> {
    try {
      const list = await fetchDecks();
      setDecks(list);
    } catch (error) {
      setDecks([]);
      setErrorMessage(error instanceof Error ? error.message : "Failed to load decks");
    }
  }

  // Deliberately no live-reload subscription (plan §2): Deck Space does not
  // track another tab's create/rename/delete while it happens to be open,
  // only its own actions reload the list — so this only fires when
  // `deckSpaceOpen` flips true, not on every render. `identity.epoch` is
  // also a dependency ([E6.T14r2] Plan §7 decision 4/§3): a sign-in/sign-out
  // reassigns owners server-side (the claim), so the visible set the next
  // `GET /api/decks` returns changes too — Deck Space must refetch, not show
  // a stale list until its next open/close toggle.
  useEffect(() => {
    if (deckSpaceOpen || deck === null) void reloadDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckSpaceOpen, deck === null, identity.epoch]);

  function switchConflictMessage(reason: string | undefined, fallback: string): string {
    if (reason === "editing") return "The agent is currently editing, please wait.";
    if (reason === "exporting") return "An export job is already in progress.";
    return fallback;
  }

  async function enter(id: string): Promise<void> {
    const result = await switchToDeck(id);
    if (!result.ok) {
      setErrorMessage(switchConflictMessage(result.reason, result.error));
      return;
    }
    setErrorMessage(null);
    setDeck(result.deck);
    setDeckSpaceOpen(false);
  }

  /** Resolves `deck.id`, registering it first if this file has never been opened (plan §7 decision 1/2: list never mints an id itself). */
  async function ensureId(target: DeckSummary): Promise<{ id: string } | { error: string }> {
    if (target.id !== null) return { id: target.id };
    const resolved = await resolveDeckId(target.fileName);
    if (!resolved.ok) return { error: resolved.error };
    return { id: resolved.id };
  }

  async function handleOpenCard(target: DeckSummary): Promise<void> {
    const resolved = await ensureId(target);
    if ("error" in resolved) {
      setErrorMessage(resolved.error);
      return;
    }
    await enter(resolved.id);
  }

  async function handleNewDeck(): Promise<void> {
    const created = await createDeck();
    if (!created.ok) {
      setErrorMessage(created.error);
      return;
    }
    await enter(created.id);
  }

  async function handleOpenFile(file: File): Promise<void> {
    const opened = await openDeckFile(file);
    if (!opened.ok) {
      setErrorMessage(opened.error);
      return;
    }
    await enter(opened.id);
  }

  async function handleRename(target: DeckSummary, name: string): Promise<string | null> {
    const resolved = await ensureId(target);
    if ("error" in resolved) return resolved.error;
    const result = await renameDeck(resolved.id, name);
    if (!result.ok) {
      if (result.reason === "name-conflict") return "A deck with that name already exists";
      if (result.reason === "deck-bound") return "Currently open — enter another deck first";
      return result.error;
    }
    await reloadDecks();
    return null;
  }

  async function handleDelete(target: DeckSummary): Promise<string | null> {
    const resolved = await ensureId(target);
    if ("error" in resolved) return resolved.error;
    const result = await deleteDeck(resolved.id);
    if (!result.ok) {
      if (result.reason === "deck-bound") return "Currently open — enter another deck first";
      return result.error;
    }
    await reloadDecks();
    return null;
  }

  if (deck === "loading") return null;

  const deckSpace = (
    <DeckSpace
      decks={decks}
      currentDeckFileName={deck?.fileName ?? null}
      canClose={deck !== null}
      onClose={() => setDeckSpaceOpen(false)}
      errorMessage={errorMessage}
      onNewDeck={() => void handleNewDeck()}
      onOpenFile={(file) => void handleOpenFile(file)}
      onOpenCard={(target) => void handleOpenCard(target)}
      onRename={handleRename}
      onDelete={handleDelete}
      userBlock={userBlock}
    />
  );

  if (deck === null) return deckSpace;

  return (
    <>
      <App key={deck.id} onOpenDeckSpace={() => setDeckSpaceOpen(true)} deckSpaceOpen={deckSpaceOpen} userBlock={userBlock} />
      {deckSpaceOpen && deckSpace}
    </>
  );
}
