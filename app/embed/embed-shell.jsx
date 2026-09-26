"use client";

// The embeddable player (/embed?deck=…): the stage and a small control bar,
// for an <iframe> on another site. lib/viewer/embed.js wires it up.

import { useEffect } from "react";

export default function EmbedShell() {
  useEffect(() => {
    import("../../lib/viewer/embed.js").then(({ startEmbed }) => startEmbed());
  }, []);

  return (
    <main id="embed" className="embed">
      <div id="e-stage" className="embed-stage">
        <div id="e-surface" className="surface">
          <iframe id="e-frame" className="slide-frame" title="Slide" sandbox="allow-scripts" allow="autoplay; fullscreen"></iframe>
          <div id="e-embeds" className="embed-layer"></div>
        </div>
      </div>
      <nav className="embed-bar" aria-label="Playback">
        <button id="e-prev" className="icon-button" type="button" aria-label="Previous">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.5 4.5 7 10l5.5 5.5" />
          </svg>
        </button>
        <span id="e-counter" className="embed-counter" aria-live="polite"></span>
        <button id="e-next" className="icon-button" type="button" aria-label="Next">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7.5 4.5 13 10l-5.5 5.5" />
          </svg>
        </button>
        <a id="e-open" className="embed-open" target="_blank" rel="noopener">
          Open in Slidra
        </a>
        <button id="e-fullscreen" className="icon-button" type="button" aria-label="Fullscreen">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
          </svg>
        </button>
      </nav>
      <p id="e-status" className="embed-status" role="status" hidden></p>
    </main>
  );
}
