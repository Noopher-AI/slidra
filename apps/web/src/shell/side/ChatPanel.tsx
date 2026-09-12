import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentUiStatus } from "../../agent-status.js";
import { AgentPicker, type AgentPickerProps } from "./AgentPicker.js";
import type { ChatMessage, CommandStatus } from "../../chat-messages.js";
import type { NumberedComment } from "../../comments.js";
import { completeDraft, filterCommands, moveSelection, slashQuery, type SlashCommandOption } from "../../slash-commands.js";
import { SlashMenu } from "./SlashMenu.js";
import { Icon } from "../../icons/index.js";

export interface ChatPanelProps {
  messages: ChatMessage[];
  working: boolean;
  streamReady: boolean;
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  /**
   * While `working` the Send button becomes a Stop button
   * (`.chat-stop`) that asks the server to cancel the agent's turn; Esc
   * in the textarea does the same. `stopping` disables it while the
   * cancel request is in flight.
   */
  onStop(): void;
  stopping: boolean;
  /**
   * The "New session" action next to the send button: drops the current ACP
   * session, clears the message list, and the next message starts from
   * scratch (`POST /api/chat/new`). The deck itself is unaffected.
   */
  onNewSession(): void;
  /** All props for the agent/model pill row below the dialog (AgentPicker); App.tsx owns the HTTP calls behind them. */
  picker: Omit<AgentPickerProps, "agent">;
  /** Plan §4.7: drives the empty state and the input's disabled/placeholder rows below `messages`. `loading`/`error` deliberately show no empty state and leave the input exactly as `streamReady` alone already decided (Plan §4.7's table, and its own note: "don't know yet" is not "known to be impossible"). */
  agent: AgentUiStatus;
  /**
   * §4.7: every pinned comment, deck-wide, sorted/numbered by
   * `sortComments`. Rendered as "Pinned context <n>" — empty means the
   * whole block doesn't render at all (not "Pinned context 0").
   */
  comments: readonly NumberedComment[];
  /** A Pinned context row was clicked: jump to its slide, select its target, open it for editing. */
  onPinnedClick(comment: NumberedComment): void;
  /** The row's own ✕ — deletes immediately, no confirmation (prototype's own rule, `slidra-logic-v3.js:665`). */
  onPinnedRemove(commentId: string): void;
  /**
   * The full `/` list — agent report ∪ bundled skills ∪
   * user skills, kept current by App.tsx's GET + `agent-commands` SSE
   * subscription. This component owns only the menu's transient UI state
   * (selection, whether Esc dismissed it); it never fetches anything.
   */
  commands: readonly SlashCommandOption[];
}

/**
 * The chat tab — its class names are kept exactly as they were before the
 * New v3 shell rebuild. This is deliberate: e2e/freeze.test.ts drives the
 * agent editing-lock freeze flow through `.chat-input button` /
 * `.chat-input textarea`, and e2e/helpers/launch.ts's
 * `openApp({ waitForAgent: true })` polls `.agent-dot` (in TitleBar.tsx, not
 * here, but under the same "don't change the existing contract" principle)
 * — neither can shift just because the shell was rebuilt. Message/draft
 * state still lives in App.tsx; this component additionally holds two
 * pieces of UI state for the slash menu on its own (selected index, whether
 * Esc dismissed it), since that's a detail of input-box interaction that
 * App.tsx doesn't need to know about.
 */
export function ChatPanel({
  messages,
  working,
  streamReady,
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  stopping,
  onNewSession,
  picker,
  agent,
  comments,
  onPinnedClick,
  onPinnedRemove,
  commands,
}: ChatPanelProps) {
  const hasComments = comments.length > 0;
  // Plan §4.7: `loading`/`error` leave the input's own disabled
  // state untouched — it stays governed by `streamReady` alone, exactly as
  // before ("don't know yet" is not "known to be impossible"; this must not
  // become "disable defensively just in case"). Only `unset`/`unauthenticated`
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

  // The slash-command menu. Two UI states only: which item
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
   * ⌘↵/Ctrl+↵ sends (06-KEYBOARD table, same as `slidra-logic-v3.js`'s
   * `draftKey`) — the input is a textarea, so plain `↵` inserts a newline
   * instead of sending. When `streamReady` is false the Send button is
   * disabled, and this keyboard path must not bypass that.
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
          message.role === "error" ? (
            <p key={message.id} className="chat-error" role="alert">
              {message.text}
            </p>
          ) : message.role === "notice" ? (
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
                !message.cli
                  ? "untagged"
                  : message.interrupted
                    ? "interrupted"
                    : message.blocked
                      ? "blocked"
                      : message.status
              }`}
              role={message.cli && message.status === "failed" ? "alert" : undefined}
            >
              <p className="chat-command-line">
                {/* Only CLI commands carry a status tag: the agent's own shell
                    work still renders, but its success/failure isn't
                    something the author needs to read (see relayCommandStart). */}
                {message.cli && (
                  <span className="chat-command-status">
                    {message.interrupted
                      ? COMMAND_INTERRUPTED_LABEL
                      : message.blocked
                        ? COMMAND_BLOCKED_LABEL
                        : COMMAND_STATUS_LABEL[message.status]}
                  </span>
                )}
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
            <p className="chat-empty-state-body">按下方的 agent 膠囊，選要用哪一個來改這份簡報</p>
          </div>
        )}
        {agent.kind === "unauthenticated" && (
          <div className="chat-empty-state">
            <p className="chat-empty-state-title">{agent.label} 尚未登入</p>
            <p className="chat-empty-state-body">
              請在終端機執行 <code>{agent.loginCommand}</code>，完成後在下方的 agent 膠囊選單裡按「重新偵測登入狀態」，或改選另一個 agent
            </p>
          </div>
        )}
        {working && <p className="chat-working">agent is working…</p>}
        {!streamReady && <p className="chat-connecting">Connecting to chat…</p>}
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
          {/* Send (or Stop) and New session belong together as one group:
              the footer itself is space-between, so as direct children the
              two buttons would get pushed to opposite ends. */}
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
      <AgentPicker agent={agent} {...picker} />
    </aside>
  );
}

/** The text shown when a command is blocked by the allowlist — not the command itself failing, and not the author declining it. */
const COMMAND_BLOCKED_LABEL = "Blocked";

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

/** ACP tool-call status -> the text the user sees. */
const COMMAND_STATUS_LABEL: Record<CommandStatus, string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "✓ Done",
  failed: "Failed",
};

/** Shown when the stream was interrupted and the outcome is unknown (not a member of CommandStatus: we genuinely don't know success or failure, so we don't make one up). */
const COMMAND_INTERRUPTED_LABEL = "Unknown";


