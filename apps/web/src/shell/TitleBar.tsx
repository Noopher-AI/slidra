// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";
import { Icon } from "../icons/index.js";
import { ExportPanel, type ExportUiState } from "./ExportPanel.js";
import type { ExportFormat } from "../live-reload.js";

export interface TitleBarProps {
  /**
   * The name shown next to the brand mark. NOOP-93: once the save-state is
   * `known`, this is `sourcePath`'s basename (the real `.slidra` filename) —
   * otherwise it falls back to `project.json`'s `name` (§4.2's table).
   * `null` = neither is available yet (`/api/presentation` hasn't returned
   * or failed — see App.tsx's `presentationError`).
   */
  deckName: string | null;
  /** "Saved" / "Unsaved changes" (NOOP-93 §4.2) — `null` when save-state is `known:false` or its request failed; no status text is shown then. */
  savedStatusText: string | null;
  /** While the agent holds the editing lock, undo/redo are always disabled (no request is sent). */
  editingFrozen: boolean;
  onUndo(): void;
  onRedo(): void;
  /** `POST /api/new`: replaces the current presentation with a brand-new one that has no slides at all. */
  onNew(): void;
  /** NOOP-93 §4.1: the browser only ever hands over bytes, never a path — App.tsx reads `file` and POSTs it. */
  onOpenFile(file: File): void;
  /** NOOP-93 §4.2: `POST /api/save`, always actually writes (see §4.2's table). */
  onSave(): void;
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
 * Open-Save-Export / Play.
 *
 * Open/Save are wired to real actions: Open triggers a hidden
 * `<input type="file" accept=".slidra">`, and once a file is picked, hands
 * the `File` to `onOpenFile` (whether there are unsaved changes and
 * whether to prompt for confirmation is App.tsx's concern — this component
 * only hands over the file the user picked); Save calls `onSave` directly.
 * The Export panel is its own dedicated component (see ExportPanel.tsx),
 * not implemented here.
 */
export function TitleBar({
  deckName,
  savedStatusText,
  editingFrozen,
  onUndo,
  onRedo,
  onNew,
  onOpenFile,
  onSave,
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Always reset — selecting the exact same file twice in a row must
    // still fire `change` the second time.
    event.target.value = "";
    if (file) onOpenFile(file);
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
      <span className="deck-name" title={deckName ?? undefined}>
        {deckName ?? "Deck info unavailable"}
      </span>
      {savedStatusText && <span className="titlebar-saved-status">{savedStatusText}</span>}
      {editingFrozen && (
        <span className="titlebar-frozen-badge" role="status">
          Agent editing · undo paused
        </span>
      )}
      <span className="spacer" />
      <div className="titlebar-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept=".slidra"
          className="titlebar-file-input"
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleFileChange}
        />
        <button type="button" className="titlebar-button" title="New" onClick={onNew}>
          <Icon name="plus" size="inline" />
          New
        </button>
        <button
          type="button"
          className="titlebar-button"
          title="Open…"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="open" size="inline" />
          Open
        </button>
        <button type="button" className="titlebar-button" title="Save (⌘S)" onClick={onSave}>
          <Icon name="save" size="inline" />
          Save
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
