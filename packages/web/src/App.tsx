import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { mountCanvas } from "./canvas.js";
import {
  appendChunkToMessage,
  appendCommandMessage,
  appendMessage,
  updateCommandMessage,
  type ChatMessage,
  type CommandStatus,
} from "./chat-messages.js";
import { startLiveReload } from "./live-reload.js";

/**
 * React owns the shell only — chat sidebar and status bar. The div below is
 * handed to the vanilla `mountCanvas` module exactly once; React never
 * re-renders into it again (ADR-0001, ADR-0002).
 */
export function App() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
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
      controller.destroy();
    };
  }, []);

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
  // The id of the agent message the *current* turn's chunks belong to, or
  // null when no reply is in flight. A chat-chunk updates this specific
  // message by id — never "whichever message happens to be last" — so a
  // message the author sends mid-turn is never mistaken for the reply
  // (fix 3).
  const activeReplyIdRef = useRef<number | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/chat/stream");

    source.addEventListener("open", () => setStreamReady(true));
    // EventSource retries on its own; "error" fires both for a drop that
    // is about to reconnect and for a terminal failure. Either way the
    // stream cannot currently hear a reply, so sending must be gated off
    // again until the next "open".
    source.addEventListener("error", () => setStreamReady(false));

    source.addEventListener("chat-chunk", (event) => {
      const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
      setMessages((prev) => {
        if (activeReplyIdRef.current !== null) {
          return appendChunkToMessage(prev, activeReplyIdRef.current, text);
        }
        const id = nextMessageIdRef.current++;
        activeReplyIdRef.current = id;
        return appendMessage(prev, id, "agent", text);
      });
      setWorking(true);
    });

    // Ticket #17: the agent is about to run a command. It becomes its own
    // message in the conversation, in the order it actually happened.
    source.addEventListener("chat-command", (event) => {
      const { toolCallId, command, status } = JSON.parse((event as MessageEvent).data) as {
        toolCallId: string;
        command: string;
        status: CommandStatus;
      };
      setMessages((prev) => appendCommandMessage(prev, nextMessageIdRef.current++, toolCallId, command, status));
      // Whatever the agent was saying ended where the command began ("現在
      // 來修改文字："). Anything it says after the command is a new
      // paragraph, not a continuation of the sentence the command
      // interrupted — so the next chunk starts a fresh agent message
      // rather than being glued onto text that is now further up.
      activeReplyIdRef.current = null;
      setWorking(true);
    });

    source.addEventListener("chat-command-update", (event) => {
      const { toolCallId, status, output } = JSON.parse((event as MessageEvent).data) as {
        toolCallId: string;
        status: CommandStatus;
        output?: string;
      };
      // `output` is only ever sent with a failure; passing it through as an
      // explicit `undefined` would erase output already shown.
      setMessages((prev) =>
        updateCommandMessage(prev, toolCallId, output === undefined ? { status } : { status, output }),
      );
    });

    source.addEventListener("chat-done", () => {
      activeReplyIdRef.current = null;
      setWorking(false);
    });

    source.addEventListener("chat-error", (event) => {
      const { message } = JSON.parse((event as MessageEvent).data) as { message: string };
      activeReplyIdRef.current = null;
      setWorking(false);
      setError(message);
    });

    return () => source.close();
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
        <footer className="status-bar">CoMotion</footer>
      </main>
      <aside className="chat-sidebar">
        <h2>對話</h2>
        <div className="chat-messages">
          {messages.length === 0 && <p className="chat-placeholder">跟 agent 說說你想怎麼改這份簡報</p>}
          {messages.map((message) =>
            message.role === "command" ? (
              <div
                key={message.id}
                className={`chat-command chat-command-${message.status}`}
                role={message.status === "failed" ? "alert" : undefined}
              >
                <p className="chat-command-line">
                  <span className="chat-command-status">{COMMAND_STATUS_LABEL[message.status]}</span>
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
