// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useState } from "react";
import { App } from "./App.js";
import { DeckSpace } from "./shell/deck-space/DeckSpace.js";
import {
  createDeck,
  deleteDeck,
  fetchDecks,
  openDeckFile,
  renameDeck,
  resolveDeckId,
  type DeckSummary,
} from "./shell/deck-space/deck-api.js";
import { useIdentity } from "./shell/user-block/use-identity.js";
import type { UserBlockProps } from "./shell/user-block/UserBlock.js";
import { getServiceClients } from "./service-runtime.js";
import { workbenchPageUrl } from "./workbench-navigation.js";
/**
 * Owns the Deck Space overlay and its lifecycle actions. This workbench is
 * fixed by the bootstrap contract: choosing another deck performs a full
 * page navigation to a different workbench, so editor state and credentials
 * are never hot-swapped inside one React tree.
 */
export function Workspace() {
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
  const currentWorkbenchId = getServiceClients().workbenchId;

  useEffect(() => {
    if (deckSpaceOpen || currentWorkbenchId === null) void reloadDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckSpaceOpen, currentWorkbenchId, identity.epoch]);

  function enter(id: string): void {
    window.location.assign(workbenchPageUrl(window.location.href, id));
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
    enter(resolved.id);
  }

  async function handleNewDeck(): Promise<void> {
    const created = await createDeck();
    if (!created.ok) {
      setErrorMessage(created.error);
      return;
    }
    enter(created.id);
  }

  async function handleOpenFile(file: File): Promise<void> {
    const opened = await openDeckFile(file);
    if (!opened.ok) {
      setErrorMessage(opened.error);
      return;
    }
    enter(opened.id);
  }

  async function handleRename(target: DeckSummary, name: string): Promise<string | null> {
    const resolved = await ensureId(target);
    if ("error" in resolved) return resolved.error;
    const result = await renameDeck(resolved.id, name);
    if (!result.ok) {
      if (result.reason === "name-conflict") return "A deck with that name already exists";
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
      return result.error;
    }
    await reloadDecks();
    return null;
  }

  const currentDeckFileName = decks?.find((candidate) => candidate.id === currentWorkbenchId)?.fileName ?? null;

  const deckSpace = (
    <DeckSpace
      decks={decks}
      canClose={currentWorkbenchId !== null}
      currentDeckFileName={currentDeckFileName}
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

  if (currentWorkbenchId === null) return deckSpace;

  return (
    <>
      <App key={currentWorkbenchId} onOpenDeckSpace={() => setDeckSpaceOpen(true)} deckSpaceOpen={deckSpaceOpen} userBlock={userBlock} />
      {deckSpaceOpen && deckSpace}
    </>
  );
}
