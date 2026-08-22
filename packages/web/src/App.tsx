import { useEffect, useRef, useState } from "react";
import { mountCanvas } from "./canvas.js";

interface ChatMessage {
  role: "author" | "agent";
  text: string;
}

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
  // Tracks whether the current SSE chunk continues the agent's in-flight
  // reply or starts a new one. A ref (not state) because the SSE
  // listeners below are registered once and must never read a stale
  // closure of `working`.
  const streamingReplyRef = useRef(false);

  useEffect(() => {
    const source = new EventSource("/api/chat/stream");

    source.addEventListener("chat-chunk", (event) => {
      const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
      setMessages((prev) => {
        if (streamingReplyRef.current) {
          const last = prev[prev.length - 1];
          return [...prev.slice(0, -1), { role: "agent", text: last.text + text }];
        }
        return [...prev, { role: "agent", text }];
      });
      streamingReplyRef.current = true;
      setWorking(true);
    });

    source.addEventListener("chat-done", () => {
      streamingReplyRef.current = false;
      setWorking(false);
    });

    source.addEventListener("chat-error", (event) => {
      const { message } = JSON.parse((event as MessageEvent).data) as { message: string };
      streamingReplyRef.current = false;
      setWorking(false);
      setError(message);
    });

    return () => source.close();
  }, []);

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "author", text }]);
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
          {messages.map((message, index) => (
            <p key={index} className={`chat-message chat-message-${message.role}`}>
              {message.text}
            </p>
          ))}
          {working && <p className="chat-working">agent 正在工作中…</p>}
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
            placeholder="輸入訊息給 agent…"
          />
          <button type="submit">送出</button>
        </form>
      </aside>
    </div>
  );
}
