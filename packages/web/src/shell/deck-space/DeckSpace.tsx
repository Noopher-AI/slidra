// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useRef, useState, type DragEvent } from "react";
import { Icon } from "../../icons/index.js";
import { UserBlock, type UserBlockProps } from "../user-block/UserBlock.js";
import { DeckCard } from "./DeckCard.js";
import type { DeckSummary } from "./deck-api.js";

export interface DeckSpaceProps {
  /** `null` while the initial `GET /api/decks` is still in flight — distinct from `[]`, an empty deck folder, so this component's own boundary (props in → markup out) stays testable without a real fetch (`Workspace.tsx` owns that). */
  decks: DeckSummary[] | null;
  /** The bound deck's own file name (never `id` — plan §7 decision 7), or `null` when no deck is open. Used only to mark a card "Current" — never to decide whether to show the Close button (see `canClose`). */
  currentDeckFileName: string | null;
  /** Whether a Close affordance should be offered. `false` when there is no editor to return to — entering the app with no deck open. */
  canClose: boolean;
  onClose(): void;
  /** A load or action failure to show as a banner — `Workspace.tsx`'s own state, not derived here. */
  errorMessage: string | null;
  onNewDeck(): void;
  onOpenFile(file: File): void;
  onOpenCard(deck: DeckSummary): void;
  /** Resolves to an error message to show inline, or `null` on success. */
  onRename(deck: DeckSummary, name: string): Promise<string | null>;
  onDelete(deck: DeckSummary): Promise<string | null>;
  /** [E6.T14r2] Plan §7 decision 4: same block, same props, as the editor rail's bottom mount — `Workspace.tsx` holds the one `useIdentity()` for the whole tree and passes it down here too. */
  userBlock: UserBlockProps;
}

/**
 * The deck-selection screen ([E6.T4]/#342): the app's landing page with no
 * deck open, and a full-screen overlay above the editor once one is.
 * Deliberately presentational — every fetch and mutation is
 * `Workspace.tsx`'s job (plan §7 decision 3), so this component's own
 * public boundary stays "props in, markup out" and testable the same way
 * `TitleBar`/`DeckCard` already are (`renderToStaticMarkup`, no fetch to
 * wait on). The one piece of state kept here is purely-local drag-overlay
 * UI, never data.
 */
export function DeckSpace({
  decks,
  currentDeckFileName,
  canClose,
  onClose,
  errorMessage,
  onNewDeck,
  onOpenFile,
  onOpenCard,
  onRename,
  onDelete,
  userBlock,
}: DeckSpaceProps) {
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function onFileInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onOpenFile(file);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDropActive(false);
    const files = event.dataTransfer.files;
    if (files.length === 0) return;
    if (files.length === 1) onOpenFile(files[0]!);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    setDropActive(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  }

  return (
    <div className="deck-space" data-can-close={canClose ? "true" : undefined}>
      <header className="deck-space-header">
        <div className="deck-space-brand">
          <span className="mark">Slidra</span>
          <span className="deck-space-title">Deck Space</span>
        </div>
        {canClose && (
          <button type="button" className="deck-space-close" title="Close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size="inline" />
          </button>
        )}
      </header>
      <div className="deck-space-toolbar">
        <button type="button" className="deck-space-action" onClick={onNewDeck}>
          <Icon name="plus" size="inline" />
          New deck
        </button>
        <button type="button" className="deck-space-action" onClick={() => fileInputRef.current?.click()}>
          <Icon name="open" size="inline" />
          Open file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".slidra"
          className="deck-space-file-input"
          aria-hidden="true"
          tabIndex={-1}
          onChange={onFileInputChange}
        />
      </div>
      {errorMessage && (
        <div role="alert" className="deck-space-error-banner">
          {errorMessage}
        </div>
      )}
      <div
        className="deck-space-body"
        data-drop-active={dropActive ? "true" : undefined}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {decks === null ? (
          <p className="deck-space-loading">Loading decks…</p>
        ) : decks.length === 0 ? (
          <div className="deck-space-empty">
            <p>No decks yet.</p>
            <button type="button" className="deck-space-action" onClick={onNewDeck}>
              <Icon name="plus" size="inline" />
              New deck
            </button>
          </div>
        ) : (
          <div className="deck-space-grid">
            {decks.map((deck) => (
              <DeckCard
                key={deck.fileName}
                deck={deck}
                isCurrent={deck.fileName === currentDeckFileName}
                onOpen={() => onOpenCard(deck)}
                onRename={(name) => onRename(deck, name)}
                onDelete={() => onDelete(deck)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="deck-space-user-slot">
        <UserBlock {...userBlock} />
      </div>
    </div>
  );
}
