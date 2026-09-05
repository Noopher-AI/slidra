import type { ChatMessage, CommandStatus } from "../../chat-messages.js";

export interface ChatPanelProps {
  messages: ChatMessage[];
  working: boolean;
  streamReady: boolean;
  error: string | null;
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
}

/**
 * 對話分頁 — 逐字搬自 App.tsx（NOOP-271/#154 之後、New v3 殼重建之前的版
 * 本），class 名稱一個都沒改。這是刻意的：e2e/freeze.test.ts 用
 * `.chat-input button` / `.chat-input input` 驅動 agent 編輯鎖的凍結流程，
 * e2e/helpers/launch.ts 的 `openApp({ waitForAgent: true })` 輪詢
 * `.agent-dot`（在 TitleBar.tsx，不在這裡，但同一個「不改既有契約」的原
 * 則）——兩者都不能因為殼重建而跟著變。狀態（messages/draft/…）仍然留在
 * App.tsx，這個元件純粹是搬過來的 JSX + 兩個小常數表，不擁有任何狀態。
 */
export function ChatPanel({ messages, working, streamReady, error, draft, onDraftChange, onSubmit }: ChatPanelProps) {
  return (
    <aside className="chat-sidebar">
      <div className="chat-messages">
        {messages.length === 0 && <p className="chat-placeholder">Tell the agent how to change this deck.</p>}
        {messages.map((message) =>
          message.role === "notice" ? (
            <p key={message.id} className="chat-notice" role="alert">
              {message.text}
            </p>
          ) : message.role === "command" ? (
            <div
              key={message.id}
              className={`chat-command chat-command-${message.interrupted ? "interrupted" : message.status}`}
              role={message.status === "failed" ? "alert" : undefined}
            >
              <p className="chat-command-line">
                <span className="chat-command-status">
                  {message.interrupted ? COMMAND_INTERRUPTED_LABEL : COMMAND_STATUS_LABEL[message.status]}
                </span>
                <code className="chat-command-text">{message.command}</code>
              </p>
              {message.output !== undefined && <pre className="chat-command-output">{message.output}</pre>}
            </div>
          ) : (
            <p key={message.id} className={`chat-message chat-message-${message.role}`}>
              {message.text}
            </p>
          ),
        )}
        {working && <p className="chat-working">agent is working…</p>}
        {!streamReady && <p className="chat-connecting">Connecting to chat…</p>}
        {error && <p className="chat-error">{error}</p>}
      </div>
      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={streamReady ? "Tell the agent how to change this deck…" : "Connecting to chat, please wait…"}
        />
        <div className="chat-input-footer">
          <span className="chat-input-hint">↵ to send</span>
          <button type="submit" aria-label="Send" title="Send (↵)" disabled={!streamReady}>
            ↑
          </button>
        </div>
      </form>
    </aside>
  );
}

/** ACP tool-call 狀態 → 使用者看到的字——逐字搬自 App.tsx。 */
const COMMAND_STATUS_LABEL: Record<CommandStatus, string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "✓ Done",
  failed: "Failed",
};

/** 串流中斷、結果不明時顯示的字（不是 CommandStatus 的一員：真的不知道成功與否，不編一個答案）。 */
const COMMAND_INTERRUPTED_LABEL = "Unknown";
