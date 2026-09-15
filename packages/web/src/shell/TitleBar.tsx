// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
  /** "Saved" / "Saving…" / "Save failed" (NOOP-422 §4(c)) — `null` when save-state is `known:false` or its request failed; no status text is shown then. There is no manual Save action any more (continuous save replaced it) — a `failed` phase is surfaced through App.tsx's own alert banner with a Retry action, not here. */
  savedStatusText: string | null;
  /** While the agent holds the editing lock, undo/redo are always disabled (no request is sent). */
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
