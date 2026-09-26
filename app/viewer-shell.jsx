"use client";

// The viewer shell: static markup the viewer (lib/viewer/app.js) wires itself
// onto after mount. React renders it once; the viewer owns the DOM from then on.

import { useEffect } from "react";

export default function ViewerShell() {
  useEffect(() => {
    import("../lib/viewer/app.js").then(({ startViewer }) => startViewer());
  }, []);

  return (
    <>
      {/* Home: pick a deck */}
      <main id="home" className="home" hidden>
        <header className="masthead">
          <a className="wordmark" href="/" aria-label="Slidra home">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <rect x="2" y="6" width="28" height="20" rx="4" />
              <path d="M13 11.5v9l7.5-4.5z" />
            </svg>
            <span>Slidra</span>
          </a>
          <nav className="masthead-links">
            <a href="/spec/slidra-format.md" target="_blank" rel="noopener">
              Format spec
            </a>
            <a href="/spec/playback.md" target="_blank" rel="noopener">
              Playback spec
            </a>
          </nav>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">.slidra viewer</p>
            <h1>
              Open a deck.
              <br />
              <em>Press play.</em>
            </h1>
            <p className="lede">
              A <code>.slidra</code> file is one SQLite database holding SVG slides, their animations, media and fonts. Drop one here and it plays in your browser. Nothing is uploaded.
            </p>
            <div className="hero-actions">
              <label className="button primary" htmlFor="file-input">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 3v10m0-10L6 7m4-4 4 4M4 13v2.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V13" />
                </svg>
                Choose a .slidra file
              </label>
              <input id="file-input" type="file" accept=".slidra,application/vnd.slidra,application/x-sqlite3" hidden />
              <span className="hint">or drag one onto the stage</span>
            </div>
          </div>

          <div id="dropzone" className="dropzone" tabIndex={0} role="button" aria-label="Drop a .slidra file here, or press Enter to choose one">
            <div className="dropzone-screen">
              <div className="dropzone-glyph" aria-hidden="true">
                <svg viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="30" />
                  <path d="M26 21v22l18-11z" />
                </svg>
              </div>
              <p className="dropzone-title">
                Drop a <span>.slidra</span> file
              </p>
              <p className="dropzone-sub">SQLite (v5) and legacy ZIP (v1–4) decks</p>
            </div>
            <div className="dropzone-legs" aria-hidden="true"></div>
          </div>
        </section>

        <section className="library" aria-labelledby="library-title">
          <div className="library-head">
            <h2 id="library-title">On this server</h2>
            <p id="library-note" className="library-note"></p>
          </div>
          <ol id="deck-list" className="deck-list"></ol>
        </section>

        <footer className="colophon">
          <span>
            Slidra — the open <code>.slidra</code> format and viewer.
          </span>
          <span className="keys">
            Play: <kbd>→</kbd> <kbd>Space</kbd> next · <kbd>←</kbd> back · <kbd>G</kbd> overview · <kbd>N</kbd> notes · <kbd>F</kbd> fullscreen
          </span>
        </footer>
      </main>

      {/* Viewer: play a deck */}
      <section id="viewer" className="viewer" hidden aria-label="Presentation">
        <div id="stage" className="stage">
          <div id="surface" className="surface">
            <iframe id="slide-frame" className="slide-frame" title="Slide" sandbox="allow-scripts" allow="autoplay; fullscreen"></iframe>
            <div id="embed-layer" className="embed-layer"></div>
          </div>
        </div>

        <div id="topbar" className="topbar chrome">
          <button id="close-button" className="icon-button" type="button" aria-label="Close deck" title="Close (Esc)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5 5 15" />
            </svg>
          </button>
          <div className="deck-title">
            <span id="deck-name" className="deck-name"></span>
            <span id="deck-meta" className="deck-meta"></span>
          </div>
        </div>

        <div id="controls" className="controls chrome" role="toolbar" aria-label="Playback">
          <button id="prev-button" className="icon-button" type="button" aria-label="Previous" title="Previous (←)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 4.5 7 10l5.5 5.5" />
            </svg>
          </button>
          <div className="counter" aria-live="polite">
            <span id="slide-counter">1 / 1</span>
            <span id="step-dots" className="step-dots" aria-hidden="true"></span>
          </div>
          <button id="next-button" className="icon-button" type="button" aria-label="Next" title="Next (→)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M7.5 4.5 13 10l-5.5 5.5" />
            </svg>
          </button>
          <span className="divider" aria-hidden="true"></span>
          <button id="overview-button" className="icon-button" type="button" aria-label="Overview" title="Overview (G)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="3" y="3" width="6" height="6" rx="1.2" />
              <rect x="11" y="3" width="6" height="6" rx="1.2" />
              <rect x="3" y="11" width="6" height="6" rx="1.2" />
              <rect x="11" y="11" width="6" height="6" rx="1.2" />
            </svg>
          </button>
          <button id="notes-button" className="icon-button" type="button" aria-label="Speaker notes" title="Speaker notes (N)" aria-pressed="false">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 4.5h12M4 8.5h12M4 12.5h8" />
              <path d="M13 13.5l3 3" />
            </svg>
          </button>
          <button id="fullscreen-button" className="icon-button" type="button" aria-label="Fullscreen" title="Fullscreen (F)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
            </svg>
          </button>
        </div>

        <div id="progress" className="progress" aria-hidden="true">
          <span id="progress-bar"></span>
        </div>

        <aside id="notes-panel" className="notes-panel" hidden aria-label="Speaker notes">
          <div className="notes-head">
            <span>Speaker notes</span>
            <span id="notes-slide"></span>
          </div>
          <p id="notes-text" className="notes-text"></p>
        </aside>

        <div id="overview" className="overview" hidden role="dialog" aria-modal="true" aria-label="Slide overview">
          <div className="overview-head">
            <h2 id="overview-title">Overview</h2>
            <button id="overview-close" className="icon-button" type="button" aria-label="Close overview" title="Close (Esc)">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 5l10 10M15 5 5 15" />
              </svg>
            </button>
          </div>
          <ol id="overview-grid" className="overview-grid"></ol>
        </div>
      </section>

      <div id="loading" className="loading" hidden>
        <span className="spinner" aria-hidden="true"></span>
        <span id="loading-text">Opening deck…</span>
      </div>
      <div id="toasts" className="toasts" role="status" aria-live="polite"></div>
      <div id="drag-veil" className="drag-veil" hidden>
        <p>Drop to play</p>
      </div>
    </>
  );
}
