// Icons are hand-drawn in this repo (traced from docs/design/base-shell.html); no third-party icon art.

export type AgentConnection = "connecting" | "connected" | "disconnected";

export interface TitleBarProps {
  /** project.json 的 name。null = /api/presentation 還沒回來或失敗（見 App.tsx 的 presentationError）。 */
  deckName: string | null;
  /** project.json 的 canvas。null 時不渲染尺寸文字，不編一個假的 1280×720。 */
  canvasSize: { width: number; height: number } | null;
  /** 真實的 /api/chat/stream 連線狀態，由 App 從 streamReady 推導。 */
  agentConnection: AgentConnection;
}

const AGENT_LABEL: Record<AgentConnection, string> = {
  connecting: "agent 連線中…",
  connected: "agent 已連線",
  disconnected: "agent 連線中斷",
};

export function TitleBar({ deckName, canvasSize, agentConnection }: TitleBarProps) {
  return (
    <header className="titlebar">
      <span className="mark">COMOTION</span>
      <span className="deck-name" title={deckName ?? undefined}>
        {deckName ?? "簡報資訊載入失敗"}
      </span>
      {canvasSize && (
        <span className="deck-meta">
          {canvasSize.width} × {canvasSize.height}
        </span>
      )}
      <span className="spacer" />
      <span className={`agent-dot agent-dot-${agentConnection}`}>
        <i />
        {AGENT_LABEL[agentConnection]}
      </span>
    </header>
  );
}
