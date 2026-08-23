import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { mountCanvas, type CanvasController, type CanvasState } from "./canvas.js";
import { appendMessage, type ChatMessage, type CommandStatus } from "./chat-messages.js";
import { startChatStream } from "./chat-stream.js";
import { startLiveReload } from "./live-reload.js";

/**
 * React owns the shell only — chat sidebar and status bar. The div below is
 * handed to the vanilla `mountCanvas` module exactly once; React never
 * re-renders into it again (ADR-0001, ADR-0002).
 */
export function App() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // The canvas module owns the selected slide (ADR-0001/ADR-0002); React
  // only mirrors it here so the paging chrome can render, and issues
  // commands back through the controller.
  const controllerRef = useRef<CanvasController | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState>({
    slides: [],
    currentIndex: -1,
    mode: "view",
    playerHasFocus: false,
    error: null,
  });
  // Ticket #5 fix round: a dead watcher used to fail silently — the SSE
  // stream closed, EventSource retried forever against a server that would
  // only ever refuse, and the author never saw anything. `startLiveReload`'s
  // `onError` now closes that loop; this state is what actually puts the
  // message on screen instead of leaving it as an unhandled event.
  const [liveReloadError, setLiveReloadError] = useState<string | null>(null);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    const controller = mountCanvas(container);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setCanvasState);
    // Live reload (ticket #5): the server pushes a `presentation-changed`
    // event over /api/events whenever a slide is modified externally;
    // reload() re-fetches and redraws without React re-rendering anything.
    // Stopped on cleanup — a live EventSource surviving unmount would leak
    // a connection per React StrictMode double-mount.
    const liveReload = startLiveReload({
      onChange: () => void controller.reload(),
      onError: setLiveReloadError,
    });
    return () => {
      liveReload.stop();
      unsubscribe();
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  // Arrow keys page the deck, but only in 檢視模式 (ticket #28). Legitimate
  // on the parent document here: the view-mode iframe is sandboxed with no
  // scripts, so the author's keystrokes never reach it. In 播放模式 the
  // keyboard belongs entirely to the runtime inside the play iframe — a
  // parent-side arrow-key listener would fight it (both would react to the
  // same ArrowRight) and cannot honour media steps at all (transient
  // activation does not survive postMessage), so this handler must stand
  // down the moment play mode starts. `canvasStateRef` (not `canvasState`
  // itself) is read inside the listener so this effect never needs to
  // re-subscribe on every state change just to see the current mode.
  const canvasStateRef = useRef(canvasState);
  canvasStateRef.current = canvasState;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (canvasStateRef.current.mode !== "view") return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Never steal an arrow key from a text field — the author is moving
      // the caret in the chat box, not paging the deck.
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const controller = controllerRef.current;
      if (!controller) return;
      event.preventDefault();
      void (event.key === "ArrowRight" ? controller.next() : controller.previous());
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const slideCount = canvasState.slides.length;
  const hasSlides = slideCount > 0;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once the EventSource connection is open and can actually receive
  // a reply. A message sent while this is false (initial connect, or
  // mid-reconnect after a drop) would be answered with no listener
  // attached — the SSE primitive keeps no history to replay, so the
  // client must know it can hear before it speaks (fix 5).
  const [streamReady, setStreamReady] = useState(false);
  // Every message gets a stable id at creation, handed out from this
  // counter — never derived from array position. A ref, not state: it is
  // read and written from both the SSE listeners and sendMessage, and
  // must never itself trigger a re-render.
  const nextMessageIdRef = useRef(0);

  useEffect(() => {
    // All of the turn bookkeeping — including what happens to a turn whose
    // ending is lost to a dropped connection — lives in chat-stream.ts so
    // it can be tested without rendering React (ticket #19).
    const stream = startChatStream({
      updateMessages: setMessages,
      setWorking,
      setStreamReady,
      setError,
      nextMessageId: () => nextMessageIdRef.current++,
    });
    return () => stream.stop();
  }, []);

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    if (!streamReady) {
      // Honest refusal, not a silent drop or a silent queue: the author
      // can see the chat is not ready yet instead of losing the message
      // with no trace.
      setError("聊天連線尚未就緒，請稍候再試一次");
      return;
    }
    const id = nextMessageIdRef.current++;
    setMessages((prev) => appendMessage(prev, id, "author", text));
    setDraft("");
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "傳送訊息失敗");
      }
    } catch {
      // `fetch` rejects (rather than resolving with a non-OK response) when
      // the connection drops entirely — e.g. the server going away between
      // `streamReady` and this call. The draft is already cleared and the
      // message already rendered above by this point, so without this catch
      // the author would see their message sitting in the conversation as
      // if it had been delivered, when it was not — fabricating success is
      // forbidden here. Reuses the same `error` state the non-OK branch
      // above uses, naming the message so it is clear which one failed.
      setError(`「${text}」傳送失敗：連線已中斷，此訊息尚未送出`);
    }
  }

  return (
    <div className="app">
      <main className="canvas-area">
        <div ref={canvasRef} className="canvas" />
        {liveReloadError && (
          <div role="alert" style={liveReloadBannerStyle}>
            即時預覽已停止：{liveReloadError}，請重新整理頁面
          </div>
        )}
        {/* 焦點不在播放器上時明確說明並提供點回去的方式 — never fail
            silently (design doc's keyboard-and-focus section). */}
        {canvasState.mode === "play" && !canvasState.playerHasFocus && (
          <div className="player-focus-notice" role="alert">
            <p>焦點不在播放器上，方向鍵目前不會有反應。</p>
            <button type="button" onClick={() => controllerRef.current?.focusPlayer()}>
              點這裡把焦點交回播放器
            </button>
          </div>
        )}
        {canvasState.mode === "play" && canvasState.error && (
          <div className="player-error-notice" role="alert">
            這一頁的效果清單無法播放：{canvasState.error}
          </div>
        )}
        {hasSlides && (
          <nav className="slide-nav">
            <button
              type="button"
              className="slide-nav-button"
              aria-label="上一頁"
              disabled={canvasState.mode !== "view" || canvasState.currentIndex <= 0}
              onClick={() => void controllerRef.current?.previous()}
            >
              ‹
            </button>
            <span className="slide-nav-position">
              {canvasState.currentIndex + 1} / {slideCount}
            </span>
            <button
              type="button"
              className="slide-nav-button"
              aria-label="下一頁"
              disabled={canvasState.mode !== "view" || canvasState.currentIndex >= slideCount - 1}
              onClick={() => void controllerRef.current?.next()}
            >
              ›
            </button>
            {canvasState.mode === "view" ? (
              <button type="button" className="play-toggle-button" onClick={() => void controllerRef.current?.play()}>
                播放
              </button>
            ) : (
              <button
                type="button"
                className="play-toggle-button"
                onClick={() => void controllerRef.current?.exitPlay()}
              >
                離開播放
              </button>
            )}
          </nav>
        )}
        <footer className="status-bar">CoMotion</footer>
      </main>
      <aside className="chat-sidebar">
        <h2>對話</h2>
        <div className="chat-messages">
          {messages.length === 0 && <p className="chat-placeholder">跟 agent 說說你想怎麼改這份簡報</p>}
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
          {working && <p className="chat-working">agent 正在工作中…</p>}
          {!streamReady && <p className="chat-connecting">聊天連線建立中…</p>}
          {error && <p className="chat-error">{error}</p>}
        </div>
        <form
          className="chat-input"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={streamReady ? "輸入訊息給 agent…" : "聊天連線建立中，請稍候…"}
          />
          <button type="submit" disabled={!streamReady}>
            送出
          </button>
        </form>
      </aside>
    </div>
  );
}

/**
 * What each ACP tool-call status means to the author. The status itself
 * stays ACP's own string all the way from the agent to here — this map is
 * the single place it becomes something a person reads.
 */
/**
 * Shown instead of the status label when the stream died before the
 * command's outcome arrived (ticket #19). Not a `CommandStatus` value: we
 * do not know whether it worked, and "執行失敗" would be a made-up answer
 * to a question nobody ever answered.
 */
const COMMAND_INTERRUPTED_LABEL = "結果不明";

const COMMAND_STATUS_LABEL: Record<CommandStatus, string> = {
  pending: "準備執行",
  in_progress: "執行中",
  completed: "已完成",
  failed: "執行失敗",
};

// Inline, not in style.css: that file is ticket #6's concurrently-edited
// territory for this fix round. A dead watcher is an error state, so this
// deliberately reads as one rather than blending into the normal chrome.
const liveReloadBannerStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#5c1a1a",
  color: "#fff",
  fontSize: "0.9rem",
};
