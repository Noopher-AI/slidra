import { useRef } from "react";
import { Icon } from "../icons/index.js";
import { ExportPanel, type ExportUiState } from "./ExportPanel.js";
import type { ExportFormat } from "../live-reload.js";

export type AgentConnection = "connecting" | "connected" | "disconnected";

export interface TitleBarProps {
  /**
   * The name shown next to the brand mark. NOOP-93: once the save-state is
   * `known`, this is `sourcePath`'s basename (the real `.comot` filename) —
   * otherwise it falls back to `project.json`'s `name` (§4.2's table).
   * `null` = neither is available yet (`/api/presentation` hasn't returned
   * or failed — see App.tsx's `presentationError`).
   */
  deckName: string | null;
  /** "Saved" / "Unsaved changes" (NOOP-93 §4.2) — `null` when save-state is `known:false` or its request failed; no status text is shown then. */
  savedStatusText: string | null;
  /** 真實的 /api/chat/stream 連線狀態，由 App 從 streamReady 推導。既有 e2e 契約（.agent-dot）延續自舊殼，此處保留同一個節點。 */
  agentConnection: AgentConnection;
  /** 目前選定的 agent 名稱（`GET /api/agent` 的 label），尚未取得或未選時為 null——此時只顯示連線狀態。 */
  agentLabel: string | null;
  /** T5/NOOP-93/#110：agent 持有編輯鎖時，undo/redo 一律停用（不送請求）。 */
  editingFrozen: boolean;
  onUndo(): void;
  onRedo(): void;
  /** NOOP-93 §4.1: the browser only ever hands over bytes, never a path — App.tsx reads `file` and POSTs it. */
  onOpenFile(file: File): void;
  /** NOOP-93 §4.2: `POST /api/save`, always actually writes (see §4.2's table). */
  onSave(): void;
  /** NOOP-93 §4.7: Export 下拉面板目前開／關。 */
  exportOpen: boolean;
  onExportToggle(): void;
  onExportClose(): void;
  onExportPick(format: ExportFormat): void;
  exportState: ExportUiState;
  onExportDismiss(): void;
  /** 從目前頁播放（標題列主要的 ▶Play 按鈕）。 */
  onPlay(): void;
  /** 從第一頁播放（▶Play 旁的小按鈕）。 */
  onPlayFromStart(): void;
  canPlay: boolean;
  /** [E3.T5]: the settings dialog's own open/closed state — drives the gear button's `aria-expanded` and its toggle behaviour (open↔close on repeated clicks, same as Export). */
  settingsOpen: boolean;
  onOpenSettings(): void;
}

const AGENT_LABEL: Record<AgentConnection, string> = {
  connecting: "Agent connecting…",
  connected: "Agent connected",
  disconnected: "Agent disconnected",
};

/**
 * 連上線之後，「Agent connected」這句話已經沒有新資訊了——真正想知道的是
 * 現在跑的是哪一個 agent，所以連上線時改顯示它的名稱。connecting／
 * disconnected 仍用原本的狀態文案（那時名稱不是重點，而且可能還沒取得）。
 */
function agentStatusText(connection: AgentConnection, label: string | null): string {
  if (connection === "connected" && label !== null) return label;
  return AGENT_LABEL[connection];
}

/**
 * 標題列 (New v3)。版面依 02-DESIGN_DOC.md §3：品牌／undo-redo／檔名／
 * Open-Save-Export／Play。
 *
 * Open／Save 現在接上真實動作（NOOP-93）：Open 觸發隱藏的
 * `<input type="file" accept=".comot">`，選檔後把 `File` 交給
 * `onOpenFile`（是否已有未儲存變更、要不要跳確認，都是 App.tsx 的事——
 * 這裡只負責把使用者選的檔案交出去）；Save 直接呼叫 `onSave`。Export
 * 面板另有專門元件（見 ExportPanel.tsx），不在這裡實作。
 */
export function TitleBar({
  deckName,
  savedStatusText,
  agentConnection,
  agentLabel,
  editingFrozen,
  onUndo,
  onRedo,
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
  settingsOpen,
  onOpenSettings,
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
        <span className="mark">CoMotion</span>
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
      <span className={`agent-dot agent-dot-${agentConnection}`}>
        <i />
        {agentStatusText(agentConnection, agentLabel)}
      </span>
      <div className="titlebar-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept=".comot"
          className="titlebar-file-input"
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleFileChange}
        />
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
        <button
          type="button"
          className="titlebar-icon-button titlebar-settings-button"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
        >
          <Icon name="settings" size="inline" />
        </button>
      </div>
    </header>
  );
}
