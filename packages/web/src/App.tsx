import { useEffect, useRef, useState } from "react";
import { mountCanvas } from "./canvas.js";
import { appendChunkToMessage, appendMessage, type ChatMessage } from "./chat-messages.js";

/**
 * React owns the shell only — chat sidebar and status bar. The div below is
 * handed to the vanilla `mountCanvas` module exactly once; React never
 * re-renders into it again (ADR-0001, ADR-0002).
 */
export function App() {
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    const controller = mountCanvas(container);
    return () => controller.destroy();
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
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "傳送訊息失敗");
    }
  }

  return (
    <div className="app">
      <main className="canvas-area">
        <div ref={canvasRef} className="canvas" />
        <footer className="status-bar">CoMotion</footer>
      </main>
      <aside className="chat-sidebar">
        <h2>對話</h2>
        <div className="chat-messages">
          {messages.length === 0 && <p className="chat-placeholder">跟 agent 說說你想怎麼改這份簡報</p>}
          {messages.map((message) => (
            <p key={message.id} className={`chat-message chat-message-${message.role}`}>
              {message.text}
            </p>
          ))}
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
