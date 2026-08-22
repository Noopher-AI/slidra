import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { mountCanvas } from "./canvas.js";
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
        {/* No behaviour yet — connecting an agent is ticket #6's job. */}
        <p className="chat-placeholder">聊天功能尚未啟用</p>
      </aside>
    </div>
  );
}

// Inline, not in style.css: that file is ticket #6's concurrently-edited
// territory for this fix round. A dead watcher is an error state, so this
// deliberately reads as one rather than blending into the normal chrome.
const liveReloadBannerStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#5c1a1a",
  color: "#fff",
  fontSize: "0.9rem",
};
