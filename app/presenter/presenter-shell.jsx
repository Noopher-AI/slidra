"use client";

// The presenter view (playback §6.1): markup lib/viewer/presenter.js wires
// itself onto after mount. Opened by the audience window (P), never on its own.

import { useEffect } from "react";

export default function PresenterShell() {
  useEffect(() => {
    import("../../lib/viewer/presenter.js").then(({ startPresenter }) => startPresenter());
  }, []);

  return (
    <main id="presenter" className="presenter">
      <header className="presenter-bar">
        <div className="presenter-where">
          <span id="p-title" className="presenter-title">
            Presenter view
          </span>
          <span id="p-counter" className="presenter-counter" aria-live="polite"></span>
          <span id="p-laser" className="presenter-laser" hidden>
            LASER ON (L)
          </span>
        </div>
        <div className="presenter-timer" role="group" aria-label="Timer">
          <span id="p-elapsed" className="presenter-elapsed" aria-label="Elapsed time">
            00:00
          </span>
          <button id="p-pause" className="presenter-button" type="button">
            Pause
          </button>
          <button id="p-reset" className="presenter-button" type="button">
            Reset
          </button>
        </div>
        <span id="p-clock" className="presenter-clock" aria-label="Time of day"></span>
      </header>

      <section className="presenter-current" aria-label="Current slide">
        <div id="p-stage" className="presenter-stage">
          <div id="p-surface" className="surface">
            <iframe id="p-frame" className="slide-frame" title="Current slide" sandbox="allow-scripts" tabIndex={-1}></iframe>
            <div id="p-embeds" className="embed-layer"></div>
            <div id="p-pointer" className="presenter-pointer-layer" hidden></div>
          </div>
        </div>
      </section>

      <aside className="presenter-side">
        <section className="presenter-next" aria-labelledby="p-next-title">
          <h2 id="p-next-title">Next</h2>
          <div className="presenter-next-thumb">
            <img id="p-next-image" alt="" hidden />
          </div>
          <p id="p-next-label" className="presenter-next-label"></p>
        </section>
        <section className="presenter-notes" aria-labelledby="p-notes-title">
          <div className="presenter-notes-head">
            <h2 id="p-notes-title">Notes</h2>
            <button id="p-smaller" className="presenter-button" type="button" aria-label="Smaller notes">
              A−
            </button>
            <button id="p-larger" className="presenter-button" type="button" aria-label="Larger notes">
              A+
            </button>
          </div>
          <div id="p-notes" className="presenter-notes-text"></div>
        </section>
      </aside>

      <footer className="presenter-controls">
        <button id="p-previous" className="presenter-button" type="button">
          ← Previous
        </button>
        <button id="p-advance" className="presenter-button is-primary" type="button">
          Next →
        </button>
      </footer>

      <div id="p-status" className="presenter-status" role="status" hidden></div>
    </main>
  );
}
