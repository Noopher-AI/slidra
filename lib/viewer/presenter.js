// The presenter view (playback §6.1), in its own window. It gets the deck's
// bytes from the audience window over a BroadcastChannel, plays a silent copy
// that follows the audience's position, and sends the presenter's keys back.
// The audience window is the one that plays for real (lib/viewer/app.js).

import { openDeck } from "./deck.js";
import { Player } from "./player.js";
import { CHANNEL_PREFIX, FORWARDED_KEYS, catchUp, formatElapsed, isSessionId, nextPosition, readPosition } from "./presenter-link.js";

const $ = (id) => document.getElementById(id);
let els;
let channel = null;
let player = null;
let deck = null;
let position = null;
let started = false;

const timer = { startedAt: Date.now(), pausedAt: null, pausedTotal: 0 };

export function startPresenter() {
  if (started) return;
  started = true;
  els = Object.fromEntries(
    Object.entries({
      title: "p-title",
      counter: "p-counter",
      elapsed: "p-elapsed",
      pause: "p-pause",
      reset: "p-reset",
      clock: "p-clock",
      stage: "p-stage",
      surface: "p-surface",
      frame: "p-frame",
      embeds: "p-embeds",
      nextImage: "p-next-image",
      nextLabel: "p-next-label",
      notes: "p-notes",
      smaller: "p-smaller",
      larger: "p-larger",
      previous: "p-previous",
      advance: "p-advance",
      status: "p-status",
    }).map(([key, id]) => [key, $(id)]),
  );

  const session = new URLSearchParams(location.search).get("session");
  if (!isSessionId(session) || typeof BroadcastChannel !== "function") {
    showStatus("Open the presenter view from a playing deck: press P in the viewer.");
    return;
  }
  channel = new BroadcastChannel(CHANNEL_PREFIX + session);
  channel.addEventListener("message", (event) => onMessage(event.data));
  channel.postMessage({ type: "hello" });
  showStatus("Connecting to the presentation…");
  setTimeout(() => {
    if (!deck) channel.postMessage({ type: "hello" });
  }, 1500);
  window.addEventListener("pagehide", () => channel && channel.postMessage({ type: "bye" }));

  wireControls();
  tick();
  setInterval(tick, 500);
}

function send(key) {
  if (channel && FORWARDED_KEYS.includes(key)) channel.postMessage({ type: "key", key });
}

function wireControls() {
  els.previous.addEventListener("click", () => send("ArrowLeft"));
  els.advance.addEventListener("click", () => send("ArrowRight"));
  els.pause.addEventListener("click", () => {
    if (timer.pausedAt === null) timer.pausedAt = Date.now();
    else {
      timer.pausedTotal += Date.now() - timer.pausedAt;
      timer.pausedAt = null;
    }
    els.pause.textContent = timer.pausedAt === null ? "Pause" : "Resume";
    tick();
  });
  els.reset.addEventListener("click", () => {
    timer.startedAt = Date.now();
    timer.pausedTotal = 0;
    timer.pausedAt = timer.pausedAt === null ? null : Date.now();
    tick();
  });
  let notesSize = 20;
  const setNotesSize = (size) => {
    notesSize = Math.max(12, Math.min(48, size));
    els.notes.style.fontSize = `${notesSize}px`;
  };
  els.smaller.addEventListener("click", () => setNotesSize(notesSize - 2));
  els.larger.addEventListener("click", () => setNotesSize(notesSize + 2));
  // A slide number being typed ends with Enter even when a button has focus.
  let typingNumber = false;
  let typingTimer = null;
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const onButton = event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter");
    if (onButton && !(typingNumber && event.key === "Enter")) return;
    if (!FORWARDED_KEYS.includes(event.key)) return;
    event.preventDefault();
    send(event.key);
    typingNumber = /^[0-9]$/.test(event.key) || (typingNumber && event.key === "Backspace");
    clearTimeout(typingTimer);
    if (typingNumber) typingTimer = setTimeout(() => (typingNumber = false), 4000);
  });
  window.addEventListener("resize", layout);
}

async function onMessage(message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "deck" && !deck && message.bytes instanceof ArrayBuffer) {
    try {
      await loadDeck(message);
    } catch (error) {
      showStatus(`The deck could not be opened here: ${error.message}`);
    }
    return;
  }
  if (message.type === "position") {
    const target = readPosition(message);
    if (target) follow(target);
    return;
  }
  if (message.type === "closed") {
    showStatus("The presentation window closed this deck. You can close this window.");
    if (player) player.destroy();
    player = null;
  }
}

async function loadDeck(message) {
  const response = await fetch("/js/player-runtime.js");
  if (!response.ok) throw new Error("the player runtime could not be loaded");
  const runtimeSource = await response.text();
  deck = await openDeck(new Uint8Array(message.bytes), { fileName: typeof message.fileName === "string" ? message.fileName : undefined });
  player = new Player({ frame: els.frame, surface: els.surface, embedLayer: els.embeds, runtimeSource, muted: true, embeds: false });
  player.load(deck);
  player.allowRemote = message.allowRemote === true;
  // Every key pressed while the copy has focus goes to the presenter view, never to the copy itself.
  player.holdKeys(true);
  player.addEventListener("key", (event) => send(event.detail.key));
  document.title = `${deck.name || "Deck"} — Presenter view`;
  els.title.textContent = deck.name || deck.fileName || "Untitled deck";
  hideStatus();
  layout();
  if (position) follow(position);
}

/** Brings the silent copy to the audience's position and updates everything around it. */
async function follow(target) {
  position = target;
  if (!player || !deck) return;
  const action = catchUp({ index: player.index, step: player.step }, target);
  if (action.kind === "advance") player.advance();
  else if (action.kind === "show") await player.show(action.index, { startAt: action.step, animate: false });
  describe(target);
}

function describe(target) {
  if (position !== target) return;
  const prepared = player.slide(target.index);
  const stepCount = prepared.plan ? prepared.plan.steps.length : 0;
  const stepText = stepCount > 0 ? ` · step ${target.step + 1} of ${stepCount}` : "";
  els.counter.textContent = `Slide ${target.index + 1} of ${target.total}${stepText}`;
  els.notes.textContent = prepared.notes || "No speaker notes on this slide.";
  els.notes.classList.toggle("is-empty", !prepared.notes);

  const next = nextPosition({ index: target.index, step: target.step, stepCount, total: target.total });
  if (next.kind === "end") {
    els.nextImage.hidden = true;
    els.nextLabel.textContent = "End of the presentation.";
    return;
  }
  const shownIndex = next.kind === "slide" ? next.index : target.index;
  const nextTitle = player.slide(shownIndex).title;
  els.nextLabel.textContent = next.kind === "step" ? `Step ${next.step + 1} of ${next.steps} on this slide (shown with every step run)` : `Slide ${next.index + 1}${nextTitle ? `: ${nextTitle}` : ""}`;
  player
    .thumbnail(shownIndex)
    .then((url) => {
      if (position !== target) return;
      els.nextImage.src = url;
      els.nextImage.hidden = false;
    })
    .catch(() => (els.nextImage.hidden = true));
}

function tick() {
  const now = timer.pausedAt ?? Date.now();
  els.elapsed.textContent = formatElapsed(now - timer.startedAt - timer.pausedTotal);
  els.elapsed.classList.toggle("is-paused", timer.pausedAt !== null);
  els.clock.textContent = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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

function hideStatus() {
  els.status.hidden = true;
}
