import { useEffect, useRef } from "react";
import { mountCanvas } from "./canvas.js";
import { startLiveReload } from "./live-reload.js";

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
    // Live reload (ticket #5): the server pushes a `presentation-changed`
    // event over /api/events whenever a slide is modified externally;
    // reload() re-fetches and redraws without React re-rendering anything.
    // Stopped on cleanup — a live EventSource surviving unmount would leak
    // a connection per React StrictMode double-mount.
    const liveReload = startLiveReload({ onChange: () => void controller.reload() });
    return () => {
      liveReload.stop();
      controller.destroy();
    };
  }, []);

  return (
    <div className="app">
      <main className="canvas-area">
        <div ref={canvasRef} className="canvas" />
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
