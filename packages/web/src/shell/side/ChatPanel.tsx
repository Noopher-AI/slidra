import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentConnection, AgentModelOption, AgentModelView, AgentUiStatus } from "../../agent-status.js";
import type { ChatMessage, CommandStatus } from "../../chat-messages.js";
import type { NumberedComment } from "../../comments.js";
import { completeDraft, filterCommands, moveSelection, slashQuery, type SlashCommandOption } from "../../slash-commands.js";
import { SlashMenu } from "./SlashMenu.js";
import { Icon } from "../../icons/index.js";

export interface ChatPanelProps {
  messages: ChatMessage[];
  working: boolean;
  streamReady: boolean;
  error: string | null;
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  /**
   * #303: while `working` the Send button becomes a Stop button
   * (`.chat-stop`) that asks the server to cancel the agent's turn; Esc
   * in the textarea does the same. `stopping` disables it while the
   * cancel request is in flight.
   */
  onStop(): void;
  stopping: boolean;
  /**
   * 送出鍵右邊的「開新對話」：丟掉目前的 ACP session、清空訊息列表，
   * 下一則訊息從零開始（`POST /api/chat/new`）。簡報本身不受影響。
   */
  onNewSession(): void;
  /** `/api/chat/stream` 的連線狀態，由 App 從 streamReady 推導。以前在標題列，現在住在對話框下面。 */
  agentConnection: AgentConnection;
  /** 目前選定的 agent 名稱（`GET /api/agent` 的 label）；還沒取得或未選時為 null，只顯示連線狀態。 */
  agentLabel: string | null;
  /** 目前 session 跑在哪個模型（`GET /api/agent` 的 model）；adapter 沒報就是 null，什麼都不顯示。 */
  agentModel: AgentModelView | null;
  /** 可切換的模型清單（`GET /api/agent` 的 `models`）與目前選的 id；清單為空時只顯示 `agentModel` 的名字。 */
  agentModelOptions: readonly AgentModelOption[];
  agentModelId: string | null;
  /** 作者在選單裡挑了另一個模型：`POST /api/agent/model`。 */
  onSelectModel(modelId: string): void;
  /** 還沒有 session、所以還沒有模型清單時，「選擇模型…」按下去：`POST /api/agent/session` 先把 session 建起來。 */
  onLoadModels(): void;
  /** [E3.T5] Plan §4.7: drives the empty state and the input's disabled/placeholder rows below `messages`. `loading`/`error` deliberately show no empty state and leave the input exactly as `streamReady` alone already decided (Plan §4.7's table, and its own note: "還不知道" is not "知道不行"). */
  agent: AgentUiStatus;
  /** The empty state's "開啟設定" button — same path the titlebar gear takes (Plan §4.7). */
  onOpenSettings(): void;
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
 * `.chat-input button` / `.chat-input textarea` 驅動 agent 編輯鎖的凍結流程，
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
  onStop,
  stopping,
  onNewSession,
  agentConnection,
  agentLabel,
  agentModel,
  agentModelOptions,
  agentModelId,
  onSelectModel,
  onLoadModels,
  agent,
  onOpenSettings,
  comments,
  onPinnedClick,
  onPinnedRemove,
  commands,
}: ChatPanelProps) {
  const hasComments = comments.length > 0;
  // [E3.T5] Plan §4.7: `loading`/`error` leave the input's own disabled
  // state untouched — it stays governed by `streamReady` alone, exactly as
  // before this ticket ("還不知道" is not "知道不行"; this must not become
  // "disable defensively just in case"). Only `unset`/`unauthenticated`
  // disable the `<textarea>` itself — the Send button additionally keeps the
  // pre-existing `!streamReady` gate, since sending is refused either way.
  const agentBlocksInput = agent.kind === "unset" || agent.kind === "unauthenticated";
  const sendDisabled = !streamReady || agentBlocksInput;
  const inputPlaceholder =
    agent.kind === "unset"
      ? "請先在設定中選擇 agent"
      : agent.kind === "unauthenticated"
        ? `${agent.label} 尚未登入`
        : streamReady
          ? "Tell the agent how to change this deck…"
          : "Connecting to chat, please wait…";

  // [E3.T3] #232/#236's slash-command menu. Two UI states only: which item
  // is highlighted, and whether Esc has dismissed the menu for the current
  // trigger span.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Multi-line input: the textarea starts one row tall and re-measures on
  // every draft change so it grows with the content (CSS caps the height
  // and scrolls beyond that).
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  // Auto-scroll: keep the newest line visible as the agent streams, but
  // only while the author is already reading the bottom. Someone who
  // scrolled up to re-read an earlier command must not be yanked back
  // down by the next chunk — so the panel stops following the moment they
  // leave the bottom, and resumes when they return to it.
  const messagesRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  function handleMessagesScroll(): void {
    const el = messagesRef.current;
    if (!el) return;
    followBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    // `working` is in the deps because the "agent is working…" line below
    // the messages changes the scroll height on its own.
  }, [messages, working]);

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

  function handleSlashKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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

  /**
   * ⌘↵／Ctrl+↵ 送出（06-KEYBOARD 表，同 `comotion-logic-v3.js` 的
   * `draftKey`）——輸入框是 textarea，plain `↵` 換行不送出。
   * `streamReady` 為 false 時 Send 鈕是 disabled，這裡的鍵盤路徑不得繞過它。
   */
  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter") return;
    if (!(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (sendDisabled) return;
    onSubmit();
  }

  /**
   * One `onKeyDown` for the input: ⌘↵／Ctrl+↵ always sends, even with the
   * slash menu open (a modifier-Enter is unambiguously "send", never
   * "complete"); every other key goes to the menu first.
   */
  function handleInputKeyDownAll(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      handleDraftKeyDown(event);
      return;
    }
    // #303: Esc stops a running turn — unless the slash menu is open, in
    // which case Esc keeps its existing meaning (dismiss the menu) and the
    // author presses it once more to stop.
    if (event.key === "Escape" && working && !showMenu) {
      event.preventDefault();
      if (!stopping) onStop();
      return;
    }
    handleSlashKeyDown(event);
  }

  return (
    <aside className="chat-sidebar">
      <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {messages.length === 0 && <p className="chat-placeholder">Tell the agent how to change this deck.</p>}
        {messages.map((message) =>
          message.role === "notice" ? (
            <p key={message.id} className="chat-notice" role="alert">
              {message.text}
            </p>
          ) : message.role === "system" ? (
            <p key={message.id} className="chat-system" role="status">
              {message.text}
            </p>
          ) : message.role === "command" ? (
            <div
              key={message.id}
              className={`chat-command chat-command-${
                message.interrupted ? "interrupted" : message.blocked ? "blocked" : message.status
              }`}
              role={message.status === "failed" ? "alert" : undefined}
            >
              <p className="chat-command-line">
                <span className="chat-command-status">
                  {message.interrupted
                    ? COMMAND_INTERRUPTED_LABEL
                    : message.blocked
                      ? COMMAND_BLOCKED_LABEL
                      : COMMAND_STATUS_LABEL[message.status]}
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
        {agent.kind === "unset" && (
          <div className="chat-empty-state">
            <p className="chat-empty-state-title">尚未選擇 agent</p>
            <p className="chat-empty-state-body">請先選擇要用哪一個 agent 來改這份簡報</p>
            <button type="button" className="chat-empty-state-button" onClick={onOpenSettings}>
              開啟設定
            </button>
          </div>
        )}
        {agent.kind === "unauthenticated" && (
          <div className="chat-empty-state">
            <p className="chat-empty-state-title">{agent.label} 尚未登入</p>
            <p className="chat-empty-state-body">
              請在終端機執行 <code>{agent.loginCommand}</code>
            </p>
            <button type="button" className="chat-empty-state-button" onClick={onOpenSettings}>
              開啟設定
            </button>
          </div>
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
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleInputKeyDownAll}
          disabled={agentBlocksInput}
          placeholder={inputPlaceholder}
        />
        <div className="chat-input-footer">
          {hasComments && <span className="chat-input-pinned">{comments.length} pinned</span>}
          <span className="chat-input-hint">⌘↵ to send</span>
          {/* 送出（或停止）與開新對話是相連的一組：footer 本身是
              space-between，兩顆鍵若各自當直接子節點就會被推到兩端。 */}
          <span className="chat-input-actions">
            {working ? (
              <button
                type="button"
                className="chat-stop"
                aria-label="Stop"
                title="停止 (Esc)"
                disabled={stopping}
                onClick={onStop}
              >
                <Icon name="stop" size="inline" />
              </button>
            ) : (
              <button type="submit" aria-label="Send" title="Send (⌘↵)" disabled={sendDisabled}>
                ↑
              </button>
            )}
            <button
              type="button"
              className="chat-new-session"
              aria-label="New session"
              title="開新對話（清空這段對話，簡報不受影響）"
              disabled={working || stopping}
              onClick={onNewSession}
            >
              ＋
            </button>
          </span>
        </div>
      </form>
      {/* 連線狀態與模型：作者真正在意這兩件事的時候，眼睛就在對話框上，
          不在標題列。`.agent-dot` 的結構與 class 逐字沿用舊的標題列節點
          （e2e/helpers/launch.ts 靠 `.agent-dot-connected` 的文字判斷連線
          完成），模型另開一個節點，不混進那段文字裡。 */}
      <div className="chat-status">
        <span className={`agent-dot agent-dot-${agentConnection}`}>
          <i />
          {agentStatusText(agentConnection, agentLabel)}
        </span>
        {agentModelOptions.length > 0 ? (
          // 有得選就是選單：切換直接送 POST /api/agent/model，回合進行中先鎖住
          // （server 也會拒絕，鎖只是不讓作者白按）。
          <select
            className="chat-status-model chat-status-model-select"
            aria-label="模型"
            title={agentModel?.detail}
            value={agentModelId ?? ""}
            disabled={working || stopping}
            onChange={(event) => onSelectModel(event.target.value)}
          >
            {agentModelId === null && <option value="">選擇模型</option>}
            {agentModelOptions.map((option) => (
              <option key={option.id} value={option.id} title={option.detail}>
                {option.name}
              </option>
            ))}
          </select>
        ) : agentModel ? (
          // claude-code-acp 把沒有指定模型時的預設叫「Default (recommended)」，
          // 真正會用到哪些模型寫在它的說明裡——名字照顯示，說明掛 tooltip。
          <span className="chat-status-model" title={agentModel.detail}>
            {agentModel.name}
          </span>
        ) : (
          agent.kind === "ready" && (
            // session 要到第一則訊息才建立，模型清單也是——想先挑就先把
            // session 叫起來（只送編輯規約，不會替作者發任何訊息）。
            <button type="button" className="chat-status-model chat-status-model-select" disabled={working || stopping} onClick={onLoadModels}>
              選擇模型…
            </button>
          )
        )}
      </div>
    </aside>
  );
}

/**
 * Whether the chat log is scrolled close enough to the bottom to keep
 * following new messages. Pure so the threshold is testable without a
 * layout engine (jsdom reports every scroll metric as 0).
 *
 * The slack exists because "at the bottom" is never exact — a fractional
 * device-pixel row height leaves a pixel or two behind, and a message that
 * grows while it streams can outrun the scroll by a line.
 */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_SLACK_PX;
}

const BOTTOM_SLACK_PX = 48;

/** ACP tool-call 狀態 → 使用者看到的字——逐字搬自 App.tsx。 */
const COMMAND_STATUS_LABEL: Record<CommandStatus, string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "✓ Done",
  failed: "Failed",
};

/** 串流中斷、結果不明時顯示的字（不是 CommandStatus 的一員：真的不知道成功與否，不編一個答案）。 */
const COMMAND_INTERRUPTED_LABEL = "Unknown";

/** 命令被 CoMotion 的白名單擋下時顯示的字——不是命令自己失敗，也不是作者按了拒絕。 */
const COMMAND_BLOCKED_LABEL = "Blocked";

const AGENT_LABEL: Record<AgentConnection, string> = {
  connecting: "Agent connecting…",
  connected: "Agent connected",
  disconnected: "Agent disconnected",
};

/**
 * 連上線之後，「Agent connected」這句話已經沒有新資訊了——真正想知道的是
 * 現在跑的是哪一個 agent，所以連上線時改顯示它的名稱。connecting／
 * disconnected 仍用原本的狀態文案（那時名稱不是重點，而且可能還沒取得）。
 * 逐字搬自 TitleBar.tsx。
 */
function agentStatusText(connection: AgentConnection, label: string | null): string {
  if (connection === "connected" && label !== null) return label;
  return AGENT_LABEL[connection];
}
