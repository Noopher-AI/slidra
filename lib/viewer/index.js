// The viewer library's public API: what another app needs to play .slidra
// decks the way this viewer does. tools/build-bundle.mjs bundles this module
// as player/slidra-viewer.js (with the slide runtime inlined as
// PLAYER_RUNTIME); test/bundle.test.mjs holds the bundle to exactly these
// names. Anything not exported here is internal and may change.
//
// Mounting the viewer's own pages: startViewer() wires itself onto the
// markup of app/viewer-shell.jsx (player/viewer-shell.html in the bundle) and
// startPresenter() onto app/presenter/presenter-shell.jsx
// (player/presenter-shell.html); both are styled by app/globals.css
// (player/slidra-viewer.css). The viewer's overview, print and export
// layouts are part of startViewer; buildPrintout, renderThumbnail and
// renderSlidePng are the pieces it builds them from.

/* global __SLIDRA_RUNTIME__ */

/**
 * The slide runtime's source (public/js/player-runtime.js), for `new Player({ runtimeSource })`.
 * Inlined in the bundle; null when this module is used unbundled (fetch /js/player-runtime.js instead).
 * @type {string | null}
 */
export const PLAYER_RUNTIME = typeof __SLIDRA_RUNTIME__ === "string" ? __SLIDRA_RUNTIME__ : null;

/** @typedef {import("./source.js").DeckSource} DeckSource */

// Reading a deck.
export { APPLICATION_ID, DEFAULT_LIMITS, Deck, DeckError, FORMAT_VERSION, NAMESPACE, deckInfo, openDeck } from "./deck.js";
export { BytesDeckSource, PlayableDeck, deckSourceFromBytes, openSource } from "./source.js";

// Playing one.
export { Player } from "./player.js";
export { prepareSlide } from "./slide.js";

// The viewer's pages: playback with its overview, notes, print and export, and the presenter view.
export { startViewer } from "./app.js";
export { startPresenter } from "./presenter.js";

// Drawing slides outside the player: thumbnails, printouts, exported images.
export { fontFaceCss, staticDocument } from "./frame.js";
export { PER_PAGE, buildPrintout, markupAtStep, printEntries } from "./print.js";
export { renderSlidePng, renderThumbnail } from "./thumbnail.js";
export { zipStore } from "./zip-writer.js";
