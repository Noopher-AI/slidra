// The embeddable player (/embed?deck=/decks/<n>/<file>[#<slide>]): a deck
// this server lists, played in an <iframe> on someone else's page, with a
// small control bar and a link to open it in the full viewer. Network
// resources stay blocked unless the server trusts its library
// (SLIDRA_ALLOW_REMOTE, format §13).

import { openDeck } from "./deck.js";
import { Player } from "./player.js";

const $ = (id) => document.getElementById(id);
let els;
let player = null;
let deck = null;
let started = false;

export async function startEmbed() {
  if (started) return;
  started = true;
  els = {
    stage: $("e-stage"),
    surface: $("e-surface"),
    frame: $("e-frame"),
    embeds: $("e-embeds"),
    prev: $("e-prev"),
    next: $("e-next"),
    counter: $("e-counter"),
    open: $("e-open"),
    fullscreen: $("e-fullscreen"),
    status: $("e-status"),
  };
  const deckUrl = new URLSearchParams(location.search).get("deck") ?? "";
  // Only this server's own decks: an embed never fetches a URL from its query string elsewhere.
  if (!deckUrl.startsWith("/decks/")) return showStatus("Nothing to play: the embed code names no deck on this server.");
  const start = Math.max(0, (Number.parseInt(location.hash.slice(1), 10) || 1) - 1);
  els.open.href = `/?deck=${encodeURIComponent(deckUrl)}#${start + 1}`;
  try {
    const [deckResponse, runtimeResponse, library] = await Promise.all([
      fetch(deckUrl),
      fetch("/js/player-runtime.js"),
      fetch("/api/decks")
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
    ]);
    if (!deckResponse.ok) throw new Error(`the deck is not available (HTTP ${deckResponse.status})`);
    deck = await openDeck(new Uint8Array(await deckResponse.arrayBuffer()), { fileName: deckUrl.split("/").pop() });
    player = new Player({ frame: els.frame, surface: els.surface, embedLayer: els.embeds, runtimeSource: await runtimeResponse.text() });
    player.load(deck);
    player.allowRemote = /** @type {{ allowRemote?: boolean }} */ (library).allowRemote === true;
  } catch (error) {
    return showStatus(`This deck cannot be shown: ${error.message}`);
  }
  document.title = `${deck.name || "Deck"} — Slidra`;
  player.addEventListener("slidechange", update);
  player.addEventListener("stepchange", update);
  player.addEventListener("key", (event) => onKey(event.detail.key));
  els.prev.addEventListener("click", () => {
    player.retreat();
    player.focusFrame();
  });
  els.next.addEventListener("click", () => {
    player.advance();
    player.focusFrame();
  });
  els.fullscreen.addEventListener("click", toggleFullscreen);
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter")) return;
    if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) player.advance();
    else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) player.retreat();
    else if (!onKey(event.key)) return;
    event.preventDefault();
  });
  window.addEventListener("resize", layout);
  document.addEventListener("fullscreenchange", layout);
  layout();
  if (deck.slides.length === 0) return showStatus("This deck has no slides.");
  await player.show(Math.min(start, deck.slides.length - 1));
}

function onKey(key) {
  if (key === "Home") player.goTo(0);
  else if (key === "End") player.goTo(deck.slides.length - 1, { startAt: "last" });
  else if (key === "f" || key === "F") toggleFullscreen();
  else return false;
  return true;
}

function update() {
  els.counter.textContent = `${player.index + 1} / ${deck.slides.length}`;
  els.prev.disabled = player.index <= 0 && player.step < 0;
  els.next.disabled = player.index >= deck.slides.length - 1 && player.step >= player.stepCount - 1;
  els.open.href = `${els.open.href.split("#")[0]}#${player.index + 1}`;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* the embedding page did not allow fullscreen */
  }
}

function layout() {
  if (!deck) return;
  const rect = els.stage.getBoundingClientRect();
  const ratio = deck.canvas.width / deck.canvas.height;
  let width = rect.width;
  let height = width / ratio;
  if (height > rect.height) {
    height = rect.height;
    width = height * ratio;
  }
  els.surface.style.setProperty("--slide-w", `${Math.floor(width)}px`);
  els.surface.style.setProperty("--slide-h", `${Math.floor(height)}px`);
}

function showStatus(text) {
  els.status.textContent = text;
  els.status.hidden = false;
}
