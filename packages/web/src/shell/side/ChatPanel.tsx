import { useEffect, useState, type KeyboardEvent } from "react";
import type { ChatMessage, CommandStatus } from "../../chat-messages.js";
import type { NumberedComment } from "../../comments.js";
import { completeDraft, filterCommands, moveSelection, slashQuery, type SlashCommandOption } from "../../slash-commands.js";
import { SlashMenu } from "./SlashMenu.js";

export interface ChatPanelProps {
  messages: ChatMessage[];
  working: boolean;
  streamReady: boolean;
  error: string | null;
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  /**
   * [E2.T8] §4.7: every pinned comment, deck-wide, sorted/numbered by
   * `sortComments`. Rendered as "Pinned context <n>" — empty means the
   * whole block doesn't render at all (not "Pinned context 0").
   */
  comments: readonly NumberedComment[];
  /** A Pinned context row was clicked: jump to its slide, select its target, open it for editing. */
  onPinnedClick(comment: NumberedComment): void;
  /** The row's own ✕ — deletes immediately, no confirmation (prototype's own rule, `comotion-logic-v3.js:665`). */
  onPinnedRemove(commentId: string): void;
  /**
   * [E3.T3] #232/#236: the full `/` list — agent report ∪ bundled skills ∪
   * user skills, kept current by App.tsx's GET + `agent-commands` SSE
   * subscription. This component owns only the menu's transient UI state
   * (selection, whether Esc dismissed it); it never fetches anything.
   */
  commands: readonly SlashCommandOption[];
}

/**
 * 對話分頁 — 逐字搬自 App.tsx（NOOP-271/#154 之後、New v3 殼重建之前的版
 * 本），class 名稱一個都沒改。這是刻意的：e2e/freeze.test.ts 用
 * `.chat-input button` / `.chat-input input` 驅動 agent 編輯鎖的凍結流程，
 * e2e/helpers/launch.ts 的 `openApp({ waitForAgent: true })` 輪詢
 * `.agent-dot`（在 TitleBar.tsx，不在這裡，但同一個「不改既有契約」的原
 * 則）——兩者都不能因為殼重建而跟著變。訊息／草稿等狀態仍然留在
 * App.tsx；[E3.T3] 起，這個元件另外自己持有斜線選單的兩個 UI 狀態（選取
 * 索引、是否被 Esc 關閉），因為那是輸入框互動的細節，App.tsx 不需要知道。
 */
export function ChatPanel({
  messages,
  working,
  streamReady,
  error,
  draft,
  onDraftChange,
  onSubmit,
  comments,
  onPinnedClick,
  onPinnedRemove,
  commands,
}: ChatPanelProps) {
  const hasComments = comments.length > 0;

  // [E3.T3] #232/#236's slash-command menu. Two UI states only: which item
  // is highlighted, and whether Esc has dismissed the menu for the current
  // trigger span.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const query = slashQuery(draft);
  // Esc's dismissal is scoped to "the trigger span currently in progress"
  // (contract: continuing to type must NOT reopen it) — only reset the
  // moment `draft` leaves the trigger condition entirely (`query` goes
  // back to `null`), never merely because the query text changed.
  useEffect(() => {
    if (query === null) setDismissed(false);
  }, [query === null]);
  // The candidate set changes on every keystroke (narrower query) and on
  // every fresh `commands` report (live update while the menu is open) —
  // either one invalidates whatever was previously highlighted, so both
  // reset the selection back to the top.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, commands]);

  const filtered = commands.length > 0 && query !== null ? filterCommands(commands, query) : [];
  const menuOpen = query !== null && !dismissed;
  const showMenu = menuOpen && (commands.length === 0 || filtered.length > 0);
  const effectiveIndex = filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);

  function selectCommand(command: SlashCommandOption): void {
    onDraftChange(completeDraft(command.name));
    setSelectedIndex(0);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!showMenu) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) setSelectedIndex(moveSelection(effectiveIndex, filtered.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) setSelectedIndex(moveSelection(effectiveIndex, filtered.length, -1));
      return;
    }
    if (event.key === "Enter") {
      // Empty state (nothing to complete to): let the keystroke fall
      // through to the form's own submit, unintercepted — a hint text must
      // never block sending a message.
      if (filtered.length === 0) return;
      event.preventDefault();
      selectCommand(filtered[effectiveIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  }

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
      {hasComments && (
        <div className="chat-pinned">
          <div className="chat-pinned-header">
            <span>
              Pinned context <span className="chat-pinned-count">{comments.length}</span>
            </span>
            <span className="chat-pinned-note">sent with your next message</span>
          </div>
          <ul className="chat-pinned-list">
            {comments.map((comment) => (
              <li key={comment.id} className="chat-pinned-item" data-comment-id={comment.id}>
                <button type="button" className="chat-pinned-item-text" onClick={() => onPinnedClick(comment)}>
                  <span className="chat-pinned-item-number">{comment.number}</span>
                  <span className="chat-pinned-item-slide">
                    Slide {comment.slideNumber}
                    {comment.target === "page" && <span className="chat-pinned-item-page">page</span>}
                  </span>
                  <span className="chat-pinned-item-body">{comment.text}</span>
                </button>
                <button
                  type="button"
                  className="chat-pinned-remove"
                  aria-label="Remove pin"
                  onClick={() => onPinnedRemove(comment.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {showMenu && <SlashMenu commands={filtered} selectedIndex={effectiveIndex} onSelect={selectCommand} />}
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={streamReady ? "Tell the agent how to change this deck…" : "Connecting to chat, please wait…"}
        />
        <div className="chat-input-footer">
          {hasComments && <span className="chat-input-pinned">{comments.length} pinned</span>}
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
