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
              <p className="dropzone-sub">SQLite (v6) and legacy (v1–5) decks</p>
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
            <div id="zoom" className="zoom">
              <iframe id="slide-frame" className="slide-frame" title="Slide" sandbox="allow-scripts" allow="autoplay; fullscreen"></iframe>
              <div id="embed-layer" className="embed-layer"></div>
              <div id="laser-layer" className="laser-layer" hidden></div>
              <div id="laser-dot" className="laser-dot" hidden aria-hidden="true"></div>
            </div>
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
          <div className="counter">
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
          <button id="presenter-button" className="icon-button" type="button" aria-label="Presenter view" title="Presenter view (P)" aria-pressed="false">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="4" width="10" height="7.5" rx="1.2" />
              <path d="M14.5 6.5h3M14.5 9.5h3M14.5 12.5h3M5 15.5h5" />
            </svg>
          </button>
          <button id="print-button" className="icon-button" type="button" aria-label="Print or export" title="Print, save as PDF or export images (Ctrl+P)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5.5 7.5V3.5h9v4M5.5 14.5h-2v-6a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v6h-2" />
              <rect x="5.5" y="11.5" width="9" height="5.5" rx=".8" />
            </svg>
          </button>
          <button id="fullscreen-button" className="icon-button" type="button" aria-label="Fullscreen" title="Fullscreen (F)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
            </svg>
          </button>
        </div>

        <p id="announcer" className="visually-hidden" aria-live="polite" aria-atomic="true"></p>

        <div id="blank" className="blank" hidden aria-hidden="true"></div>

        <div id="goto" className="goto" role="status" hidden>
          Go to slide <b id="goto-number"></b> <kbd>Enter</kbd>
        </div>

        <div id="print-dialog" className="key-help" role="dialog" aria-modal="true" aria-labelledby="print-title" hidden>
          <form id="print-form" className="key-help-card print-form">
            <div className="key-help-head">
              <h2 id="print-title">Print or export</h2>
              <button id="print-cancel" className="icon-button" type="button" aria-label="Cancel" title="Cancel (Esc)">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5 5l10 10M15 5 5 15" />
                </svg>
              </button>
            </div>
            <fieldset>
              <legend>Layout</legend>
              <label>
                <input type="radio" name="layout" value="slides" defaultChecked /> One slide per page
              </label>
              <label>
                <input type="radio" name="layout" value="handout-2" /> Handout, 2 per page
              </label>
              <label>
                <input type="radio" name="layout" value="handout-3" /> Handout, 3 per page
              </label>
              <label>
                <input type="radio" name="layout" value="handout-6" /> Handout, 6 per page
              </label>
            </fieldset>
            <fieldset>
              <legend>Include</legend>
              <label>
                <input type="checkbox" name="notes" /> Speaker notes
              </label>
              <label>
                <input type="checkbox" name="steps" /> Every animation step as its own slide
              </label>
            </fieldset>
            <p className="print-hint">In the print dialog, choose “Save as PDF” as the destination to get a PDF.</p>
            <div className="print-actions">
              <button id="print-go" className="remote-allow" type="submit">
                Print…
              </button>
              <button id="export-slide" className="presenter-button" type="button">
                Current slide as PNG
              </button>
              <button id="export-all" className="presenter-button" type="button">
                All slides as PNG (.zip)
              </button>
            </div>
          </form>
        </div>

        <div id="key-help" className="key-help" role="dialog" aria-modal="true" aria-labelledby="key-help-title" hidden>
          <div className="key-help-card">
            <div className="key-help-head">
              <h2 id="key-help-title">Keyboard shortcuts</h2>
              <button id="key-help-close" className="icon-button" type="button" aria-label="Close" title="Close (Esc)">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5 5l10 10M15 5 5 15" />
                </svg>
              </button>
            </div>
            <dl className="key-help-list">
              <dt>
                <kbd>→</kbd> <kbd>Space</kbd> <kbd>PageDown</kbd> <kbd>Enter</kbd>
              </dt>
              <dd>Next step or slide</dd>
              <dt>
                <kbd>←</kbd> <kbd>PageUp</kbd> <kbd>Backspace</kbd>
              </dt>
              <dd>Previous step or slide</dd>
              <dt>
                <kbd>Home</kbd> <kbd>End</kbd>
              </dt>
              <dd>First slide, end of the last slide</dd>
              <dt>
                <kbd>1</kbd>…<kbd>9</kbd> then <kbd>Enter</kbd>
              </dt>
              <dd>Go to that slide</dd>
              <dt>
                <kbd>B</kbd> <kbd>.</kbd>
              </dt>
              <dd>Black screen (any key returns)</dd>
              <dt>
                <kbd>W</kbd> <kbd>,</kbd>
              </dt>
              <dd>White screen</dd>
              <dt>
                <kbd>G</kbd> <kbd>O</kbd>
              </dt>
              <dd>Overview of all slides</dd>
              <dt>
                <kbd>N</kbd>
              </dt>
              <dd>Speaker notes</dd>
              <dt>
                <kbd>P</kbd>
              </dt>
              <dd>Presenter view in a second window</dd>
              <dt>
                <kbd>Ctrl</kbd> <kbd>P</kbd>
              </dt>
              <dd>Print or save as PDF</dd>
              <dt>
                <kbd>L</kbd>
              </dt>
              <dd>Laser pointer</dd>
              <dt>
                <kbd>Z</kbd>
              </dt>
              <dd>Magnify around the pointer</dd>
              <dt>
                <kbd>F</kbd>
              </dt>
              <dd>Fullscreen</dd>
              <dt>
                <kbd>?</kbd>
              </dt>
              <dd>This list</dd>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>Close a panel, leave fullscreen, close the deck</dd>
            </dl>
          </div>
        </div>

        <div id="remote-notice" className="remote-notice" role="region" aria-label="External content" hidden>
          <p id="remote-text"></p>
          <button id="remote-allow" className="remote-allow" type="button">
            Load external content
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
            <div className="overview-title">
              <h2 id="overview-title">Overview</h2>
              <p id="overview-about" className="overview-about" hidden></p>
            </div>
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
