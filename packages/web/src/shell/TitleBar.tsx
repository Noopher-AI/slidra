import { Icon } from "../icons/index.js";

export type AgentConnection = "connecting" | "connected" | "disconnected";

export interface TitleBarProps {
  /** project.json 的 name。null = /api/presentation 還沒回來或失敗（見 App.tsx 的 presentationError）。 */
  deckName: string | null;
  /** 真實的 /api/chat/stream 連線狀態，由 App 從 streamReady 推導。既有 e2e 契約（.agent-dot）延續自舊殼，此處保留同一個節點。 */
  agentConnection: AgentConnection;
  /** T5/NOOP-93/#110：agent 持有編輯鎖時，undo/redo 一律停用（不送請求）。 */
  editingFrozen: boolean;
  onUndo(): void;
  onRedo(): void;
  /** 從目前頁播放（標題列主要的 ▶Play 按鈕）。 */
  onPlay(): void;
  /** 從第一頁播放（▶Play 旁的小按鈕）。 */
  onPlayFromStart(): void;
  canPlay: boolean;
}

const AGENT_LABEL: Record<AgentConnection, string> = {
  connecting: "agent 連線中…",
  connected: "agent 已連線",
  disconnected: "agent 連線中斷",
};

/**
 * 標題列 (New v3 skeleton)。版面依 02-DESIGN_DOC.md §3：品牌／undo-redo／
 * 檔名／Open-Save-Export／Play。
 *
 * Open/Save/Export 沒有對應的後端動作可接（CanvasController 沒有
 * open/save/export 成員，這份骨架票也沒有指定要新增），所以三顆按鈕渲染
 * 成停用態的容器，不假裝有功能——見 PR 報告「規格要求但這次沒做的」。
 * 同理，樣板的「Saved」文字需要一個目前系統沒有的髒值/存檔狀態信號，這裡
 * 不生造一個假的存檔狀態，只顯示檔名。
 */
export function TitleBar({
  deckName,
  agentConnection,
  editingFrozen,
  onUndo,
  onRedo,
  onPlay,
  onPlayFromStart,
  canPlay,
}: TitleBarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="mark">CoMotion</span>
        <span className="titlebar-beta">BETA</span>
      </div>
      <div className="titlebar-history" role="group" aria-label="復原／重做">
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
        {deckName ?? "簡報資訊載入失敗"}
      </span>
      {editingFrozen && (
        <span className="titlebar-frozen-badge" role="status">
          Agent editing · undo paused
        </span>
      )}
      <span className="spacer" />
      <span className={`agent-dot agent-dot-${agentConnection}`}>
        <i />
        {AGENT_LABEL[agentConnection]}
      </span>
      <div className="titlebar-actions">
        <button type="button" className="titlebar-button" title="Open…" disabled>
          <Icon name="open" size="inline" />
          Open
        </button>
        <button type="button" className="titlebar-button" title="Save (⌘S)" disabled>
          <Icon name="save" size="inline" />
          Save
        </button>
        <button type="button" className="titlebar-button" title="Export" disabled>
          <Icon name="export" size="inline" />
          Export
        </button>
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
