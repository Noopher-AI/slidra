// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "../../icons/index.js";
import { thumbnailUrl, type DeckSummary } from "./deck-api.js";
import { getServiceClients } from "../../service-runtime.js";

export interface DeckCardProps {
  deck: DeckSummary;
  /** Compared by `fileName`, never `id` (plan §7 decision 7 — a registry can hold more than one entry for the same path). */
  isCurrent: boolean;
  onOpen(): void;
  /** Resolves to an error message to show inline, or `null` on success. */
  onRename(name: string): Promise<string | null>;
  onDelete(): Promise<string | null>;
}

const DISABLED_TITLE = "Currently open — enter another deck first";

const lastModifiedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatLastModified(mtimeMs: number): string {
  return lastModifiedFormat.format(new Date(mtimeMs));
}

export function DeckCard({ deck, isCurrent, onOpen, onRename, onDelete }: DeckCardProps) {
  const [thumbnailObjectUrl, setThumbnailObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setThumbnailObjectUrl(null);
    setThumbnailFailed(false);
    void getServiceClients().deck.fetch(thumbnailUrl(deck.fileName, deck.lastModified)).then(async (response) => {
      if (!response.ok) throw new Error(`Thumbnail failed (${response.status})`);
      objectUrl = URL.createObjectURL(await response.blob());
      if (active) setThumbnailObjectUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(() => {
      if (active) setThumbnailFailed(true);
    });
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [deck.fileName, deck.lastModified]);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const title = deck.name ?? deck.fileName;

  function stop(event: MouseEvent): void {
    event.stopPropagation();
  }

  function startRename(event: MouseEvent): void {
    stop(event);
    setDraftName(title);
    setRenameError(null);
    setEditing(true);
    setConfirmingDelete(false);
  }

  function cancelRename(event?: MouseEvent): void {
    if (event) stop(event);
    setEditing(false);
    setRenameError(null);
  }

  async function confirmRename(event?: MouseEvent): Promise<void> {
    if (event) stop(event);
    const trimmed = draftName.trim();
    if (trimmed === "" || renaming) return;
    setRenaming(true);
    const error = await onRename(trimmed);
    setRenaming(false);
    if (error) {
      setRenameError(error);
      return;
    }
    setEditing(false);
  }

  function onRenameInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") void confirmRename();
    if (event.key === "Escape") cancelRename();
  }

  async function handleDeleteClick(event: MouseEvent): Promise<void> {
    stop(event);
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setDeleteError(null);
      return;
    }
    setDeleting(true);
    const error = await onDelete();
    setDeleting(false);
    if (error) {
      setDeleteError(error);
      setConfirmingDelete(false);
      return;
    }
  }

  function cancelDelete(event: MouseEvent): void {
    stop(event);
    setConfirmingDelete(false);
    setDeleteError(null);
  }

  function handleCardClick(): void {
    if (editing) return;
    onOpen();
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (editing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      className="deck-card"
      data-current={isCurrent ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <div className="deck-card-thumb-wrap">
        {thumbnailFailed || thumbnailObjectUrl === null ? (
          <div className="deck-card-thumb-placeholder" aria-hidden="true" />
        ) : (
          <img
            className="deck-card-thumb"
            loading="lazy"
            alt=""
            src={thumbnailObjectUrl}
            onError={() => setThumbnailFailed(true)}
          />
        )}
        {isCurrent && <span className="deck-card-current-badge">Current</span>}
      </div>
      <div className="deck-card-meta">
        {editing ? (
          <input
            className="deck-card-rename-input"
            value={draftName}
            autoFocus
            onClick={stop}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={onRenameInputKeyDown}
          />
        ) : (
          <span className="deck-card-name" title={title}>
            {title}
          </span>
        )}
        <span className="deck-card-modified">{formatLastModified(deck.lastModified)}</span>
        {renameError && (
          <span className="deck-card-error" role="alert">
            {renameError}
          </span>
        )}
        {deleteError && (
          <span className="deck-card-error" role="alert">
            {deleteError}
          </span>
        )}
      </div>
      <div className="deck-card-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="deck-card-text-button"
              disabled={draftName.trim() === "" || renaming}
              onClick={(event) => void confirmRename(event)}
            >
              Save
            </button>
            <button type="button" className="deck-card-text-button" onClick={cancelRename}>
              Cancel
            </button>
          </>
        ) : confirmingDelete ? (
          <>
            <button type="button" className="deck-card-text-button" disabled={deleting} onClick={(event) => void handleDeleteClick(event)}>
              Confirm delete
            </button>
            <button type="button" className="deck-card-text-button" onClick={cancelDelete}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="deck-card-icon-button"
              title={isCurrent ? DISABLED_TITLE : "Rename"}
              aria-label="Rename"
              disabled={isCurrent}
              onClick={startRename}
            >
              <Icon name="edit" size="inline" />
            </button>
            <button
              type="button"
              className="deck-card-icon-button"
              title={isCurrent ? DISABLED_TITLE : "Delete"}
              aria-label="Delete"
              disabled={isCurrent}
              onClick={(event) => void handleDeleteClick(event)}
            >
              <Icon name="trash" size="inline" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
