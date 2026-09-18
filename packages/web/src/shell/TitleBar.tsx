// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useState, type KeyboardEvent } from "react";
import { Icon } from "../icons/index.js";
import { ExportPanel, type ExportUiState } from "./ExportPanel.js";
import type { ExportFormat } from "../live-reload.js";

export interface TitleBarProps {
  /** The presentation name; `null` until the credentialed request succeeds. */
  deckName: string | null;
  /** Resolves to an inline rename error, or `null` on success. */
  onRenameDeck(name: string): Promise<string | null>;
  /** `"Saved"` once loaded: every command is durably written before returning. */
  savedStatusText: string | null;
  /** While the agent holds the editing lock, undo/redo are disabled. */
  editingFrozen: boolean;
  onUndo(): void;
  onRedo(): void;
  /** [E6.T4]: opens Deck Space (`Workspace.tsx`'s own overlay) — replaces the New/Open buttons this component used to render (AC5); deck creation/open/rename/delete now all live in Deck Space itself. */
  onOpenDeckSpace(): void;
  /** Whether the Export dropdown panel is currently open. */
  exportOpen: boolean;
  onExportToggle(): void;
  onExportClose(): void;
  onExportPick(format: ExportFormat): void;
  exportState: ExportUiState;
  onExportDismiss(): void;
  /** Plays from the current page (the title bar's main ▶Play button). */
  onPlay(): void;
  /** Plays from the first page (the small button next to ▶Play). */
  onPlayFromStart(): void;
  canPlay: boolean;
}

/**
 * The title bar (New v3). Layout: brand mark / undo-redo / filename /
 * Open-Export / Play.
 *
 * There is no Save button or keyboard shortcut any more (NOOP-422:
 * continuous save writes back on its own; `savedStatusText` is the only
 * save-related thing this component still shows). The Export panel is its
 * own dedicated component (see ExportPanel.tsx), not implemented here.
 */
export function TitleBar({
  deckName,
  onRenameDeck,
  savedStatusText,
  editingFrozen,
  onUndo,
  onRedo,
  onOpenDeckSpace,
  exportOpen,
  onExportToggle,
  onExportClose,
  onExportPick,
  exportState,
  onExportDismiss,
  onPlay,
  onPlayFromStart,
  canPlay,
}: TitleBarProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  function startRename(): void {
    if (deckName === null) return;
    setDraftName(deckName.replace(/\.slidra$/, ""));
    setRenameError(null);
    setEditing(true);
  }

  function cancelRename(): void {
    setEditing(false);
    setRenameError(null);
  }

  async function confirmRename(): Promise<void> {
    const trimmed = draftName.trim();
    if (trimmed === "" || renaming) return;
    setRenaming(true);
    const error = await onRenameDeck(trimmed);
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

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="mark">Slidra</span>
        <span className="titlebar-beta">BETA</span>
      </div>
      <span className="titlebar-divider" />
      <div className="titlebar-history" role="group" aria-label="Undo / Redo">
        <button
          type="button"
          className="titlebar-icon-button"
          title="Undo (⌘Z)"
          aria-label="Undo"
          disabled={editingFrozen}
          onClick={onUndo}
        >
          <Icon name="undo" size="inline" />
        </button>
        <button
          type="button"
          className="titlebar-icon-button"
          title="Redo (⇧⌘Z)"
          aria-label="Redo"
          disabled={editingFrozen}
          onClick={onRedo}
        >
          <Icon name="redo" size="inline" />
        </button>
      </div>
      {editing ? (
        <span className="deck-name-rename">
          <input
            className="deck-name-rename-input"
            value={draftName}
            autoFocus
            disabled={renaming}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={onRenameInputKeyDown}
          />
          <button
            type="button"
            className="titlebar-icon-button"
            title="Save name"
            aria-label="Save name"
            disabled={draftName.trim() === "" || renaming}
            onClick={() => void confirmRename()}
          >
            <Icon name="save" size="inline" />
          </button>
          <button
            type="button"
            className="titlebar-icon-button"
            title="Cancel rename"
            aria-label="Cancel rename"
            disabled={renaming}
            onClick={cancelRename}
          >
            <Icon name="close" size="inline" />
          </button>
          {renameError && (
            <span className="deck-name-rename-error" role="alert">
              {renameError}
            </span>
          )}
        </span>
      ) : (
        <span
          className="deck-name"
          title={deckName ?? undefined}
          onDoubleClick={startRename}
        >
          {deckName ?? "Deck info unavailable"}
        </span>
      )}
      {savedStatusText && (
        <span
          className="titlebar-saved-status"
          data-state={savedStatusText === "Save failed" ? "failed" : undefined}
        >
          {savedStatusText}
        </span>
      )}
      {editingFrozen && (
        <span className="titlebar-frozen-badge" role="status">
          Agent editing · undo paused
        </span>
      )}
      <span className="spacer" />
      <div className="titlebar-actions">
        <button type="button" className="titlebar-button" title="Deck Space" onClick={onOpenDeckSpace}>
          <Icon name="view-grid" size="inline" />
          Deck Space
        </button>
        <ExportPanel
          open={exportOpen}
          onToggle={onExportToggle}
          onClose={onExportClose}
          onPick={onExportPick}
          canExport={canPlay}
          state={exportState}
          onDismiss={onExportDismiss}
        />
        <div className="titlebar-play-group">
          <button type="button" className="play-button" data-view="play" disabled={!canPlay} onClick={onPlay}>
            <Icon name="play" size="inline" />
            Play
          </button>
          <button
            type="button"
            className="play-from-start-button"
            title="Play from start"
            aria-label="Play from start"
            disabled={!canPlay}
            onClick={onPlayFromStart}
          >
            <Icon name="fromstart" size="inline" />
          </button>
        </div>
      </div>
    </header>
  );
}
