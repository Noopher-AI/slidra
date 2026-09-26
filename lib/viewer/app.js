// The viewer application: the home page (pick or drop a deck), and the
// player UI around the Player (controls, overview, notes, fullscreen).
//
// URLs: `/` is home; `/?deck=<url>#<n>` plays the deck at <url> from slide
// <n> (1-based). A deck opened from a local file plays at `/#<n>`.

import { DEFAULT_LIMITS, openDeck } from "./deck.js";
import { fontFaceCss, staticDocument } from "./frame.js";
import { renderThumbnail } from "./thumbnail.js";
import { CHANNEL_PREFIX, FORWARDED_KEYS, newSessionId } from "./presenter-link.js";
import { Player } from "./player.js";
import { prepareSlide } from "./slide.js";

const $ = (id) => document.getElementById(id);
const IDLE_MS = 2600;

let els;

const elementIds = {
  home: "home",
  viewer: "viewer",
  fileInput: "file-input",
  dropzone: "dropzone",
  deckList: "deck-list",
  libraryNote: "library-note",
  stage: "stage",
  surface: "surface",
  frame: "slide-frame",
  embedLayer: "embed-layer",
  deckName: "deck-name",
  deckMeta: "deck-meta",
  counter: "slide-counter",
  stepDots: "step-dots",
  progressBar: "progress-bar",
  controls: "controls",
  prev: "prev-button",
  next: "next-button",
  overviewButton: "overview-button",
  notesButton: "notes-button",
  fullscreenButton: "fullscreen-button",
  closeButton: "close-button",
  notesPanel: "notes-panel",
  notesText: "notes-text",
  notesSlide: "notes-slide",
  overview: "overview",
  overviewGrid: "overview-grid",
  overviewClose: "overview-close",
  overviewAbout: "overview-about",
  loading: "loading",
  loadingText: "loading-text",
  toasts: "toasts",
  dragVeil: "drag-veil",
  remoteNotice: "remote-notice",
  presenterButton: "presenter-button",
  blank: "blank",
  goto: "goto",
  gotoNumber: "goto-number",
  keyHelp: "key-help",
  keyHelpClose: "key-help-close",
  remoteText: "remote-text",
  remoteAllow: "remote-allow",
};

let runtimeSource = null;
let player = null;
let deck = null;
let deckUrl = null;
let idleTimer = null;
let thumbObserver = null;
/** The open deck's file, kept to hand to a presenter view. */
let deckBytes = null;
/** @type {{ id: string, channel: BroadcastChannel, popup: Window, connected: boolean } | null} */
let presenter = null;
/** Whether decks the server lists may load network resources without asking (SLIDRA_ALLOW_REMOTE). */
let serverAllowsRemote = false;

// ─── Boot ────────────────────────────────────────────────────────────────

let booted = false;

/** Wires the viewer onto the rendered shell. Safe to call more than once; only the first call does anything. */
export function startViewer() {
  if (booted) return;
  booted = true;
  els = Object.fromEntries(Object.entries(elementIds).map(([key, id]) => [key, $(id)]));
  boot().catch((error) => {
    hideLoading();
    toast(error.message);
  });
}

async function boot() {
  wireHome();
  wireViewer();
  wireDragAndDrop();
  const params = new URLSearchParams(location.search);
  const url = params.get("deck");
  if (url) {
    await openFromUrl(url, slideFromHash());
  } else {
    showHome();
  }
  window.addEventListener("popstate", onPopState);
}

async function loadRuntime() {
  if (runtimeSource) return runtimeSource;
  const response = await fetch("/js/player-runtime.js");
  if (!response.ok) throw new Error("could not load the player runtime");
  runtimeSource = await response.text();
  return runtimeSource;
}

function slideFromHash() {
  const n = Number.parseInt(location.hash.slice(1), 10);
  return Number.isInteger(n) && n > 0 ? n - 1 : 0;
}

async function onPopState() {
  const url = new URLSearchParams(location.search).get("deck");
  if (url && url === deckUrl && deck) {
    const index = slideFromHash();
    if (index !== player.index) player.goTo(index, { animate: false });
  } else if (url) {
    await openFromUrl(url, slideFromHash(), { push: false });
  } else if (deck) {
    closeDeck({ push: false });
  }
}

// ─── Home ────────────────────────────────────────────────────────────────

function showHome() {
  document.title = "Slidra Viewer";
  els.viewer.hidden = true;
  els.home.hidden = false;
  loadLibrary();
}

function wireHome() {
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = "";
    if (file) openFromFile(file);
  });
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });
}

let libraryLoaded = false;

async function loadLibrary() {
  if (libraryLoaded) return;
  libraryLoaded = true;
  els.deckList.replaceChildren();
  let decks = [];
  let dir = "decks/";
  try {
    const response = await fetch("/api/decks");
    if (response.ok) {
      const body = await response.json();
      decks = Array.isArray(body.decks) ? body.decks : [];
      serverAllowsRemote = body.allowRemote === true;
      if (typeof body.directory === "string") dir = body.directory;
    }
  } catch {
    /* a static host without the API simply has no library */
  }
  els.libraryNote.innerHTML = "";
  els.libraryNote.append("Serving ", Object.assign(document.createElement("code"), { textContent: dir }));

  if (decks.length === 0) {
    const empty = document.createElement("li");
    empty.className = "deck-empty";
    empty.textContent = "No decks here yet. Put .slidra files in the decks directory (or pass a directory to the server) and reload — or just drop a file on the stage above.";
    els.deckList.append(empty);
    return;
  }
  decks.forEach((entry, i) => {
    const item = document.createElement("li");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "deck-card";
    card.style.animationDelay = `${i * 60}ms`;
    const thumb = document.createElement("div");
    thumb.className = "deck-thumb";
    const glyph = document.createElement("span");
    glyph.className = "thumb-glyph";
    glyph.textContent = ".slidra";
    thumb.append(glyph);
    const info = document.createElement("div");
    info.className = "deck-info";
    const title = document.createElement("strong");
    title.textContent = entry.name.replace(/\.slidra$/i, "");
    const meta = document.createElement("span");
    meta.textContent = `${entry.path} · ${formatBytes(entry.size)}`;
    info.append(title, meta);
    card.append(thumb, info);
    card.addEventListener("click", () => openFromUrl(entry.url, 0));
    item.append(card);
    els.deckList.append(item);
    renderLibraryThumb(entry, thumb, title, meta);
  });
}

/** Fetches a library deck to paint its first slide and real name; failures just leave the placeholder. */
async function renderLibraryThumb(entry, thumb, title, meta) {
  try {
    const bytes = await fetchBytes(entry.url);
    const libraryDeck = await openDeck(bytes, { fileName: entry.name });
    const info = libraryDeck.info;
    title.textContent = libraryDeck.name || title.textContent;
    meta.textContent = [`${libraryDeck.slides.length} slide${libraryDeck.slides.length === 1 ? "" : "s"}`, info.author, formatBytes(entry.size)].filter(Boolean).join(" · ");
    if (info.description) title.closest("button").title = info.description;
    if (libraryDeck.slides.length === 0) return;
    const prepared = prepareSlide(libraryDeck, info.cover);
    const image = document.createElement("img");
    image.alt = "";
    image.dataset.slide = String(info.cover + 1);
    image.src = await renderThumbnail(prepared.markup, fontFaceCss(libraryDeck), libraryDeck.canvas, 480);
    thumb.replaceChildren(image);
  } catch {
    /* keep the placeholder */
  }
}

// ─── Opening decks ───────────────────────────────────────────────────────

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function openFromUrl(url, startIndex, { push = true } = {}) {
  showLoading(`Opening ${decodeURIComponent(url.split("/").pop() || "deck")}…`);
  try {
    const bytes = await fetchBytes(url);
    const opened = await openDeck(bytes, { fileName: url.split("/").pop() });
    deckUrl = url;
    if (url.startsWith("/decks/")) await loadServerSettings();
    if (push) history.pushState(null, "", `/?deck=${encodeURIComponent(url)}#${startIndex + 1}`);
    await startDeck(opened, startIndex, bytes);
  } catch (error) {
    hideLoading();
    toast(error.message);
    if (!deck) {
      history.replaceState(null, "", "/");
      showHome();
    }
  }
}

async function openFromFile(file) {
  if (file.size > DEFAULT_LIMITS.maxDeckBytes) {
    toast(`"${file.name}" is larger than the ${Math.round(DEFAULT_LIMITS.maxDeckBytes / 1024 / 1024)} MB this viewer opens.`);
    return;
  }
  if (!/\.slidra$/i.test(file.name)) {
    toast(`"${file.name}" does not end in .slidra — trying to open it anyway.`);
  }
  showLoading(`Opening ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const opened = await openDeck(bytes, { fileName: file.name });
    deckUrl = null;
    history.pushState(null, "", "/#1");
    await startDeck(opened, 0, bytes);
  } catch (error) {
    hideLoading();
    toast(error.message);
  }
}

async function startDeck(opened, startIndex, bytes) {
  endPresenterLink();
  deckBytes = bytes;
  const source = await loadRuntime();
  if (player) player.destroy();
  deck = opened;
  player = new Player({ frame: els.frame, surface: els.surface, embedLayer: els.embedLayer, runtimeSource: source });
  wirePlayer(player);
  player.load(deck);
  blank = null;
  els.blank.hidden = true;
  els.viewer.classList.remove("is-blank");
  els.keyHelp.hidden = true;
  updateTypedNumber("");
  // Network resources wait for the viewer's consent (format §13), unless the server trusts its own library.
  player.allowRemote = deckUrl !== null && deckUrl.startsWith("/decks/") && serverAllowsRemote;
  els.remoteNotice.hidden = true;

  document.title = `${deck.name || deck.fileName || "Deck"} — Slidra`;
  els.deckName.textContent = deck.name || deck.fileName || "Untitled deck";
  const info = deck.info;
  els.deckMeta.textContent = [
    info.author,
    deck.fileName,
    `${deck.canvas.width}×${deck.canvas.height}`,
    deck.container === "zip" ? `legacy v${deck.project.formatVersion}` : `v${deck.project.formatVersion}`,
  ]
    .filter(Boolean)
    .join(" · ");
  renderAbout(info);
  for (const problem of info.problems) console.warn(`[slidra] ${problem}`);
  els.home.hidden = true;
  els.viewer.hidden = false;
  closeOverview();
  layoutStage();
  hideLoading();
  poke();

  if (deck.slides.length === 0) {
    els.frame.srcdoc = staticDocument("", "");
    updateCounter();
    toast("This deck has no slides.");
    return;
  }
  await player.show(Math.min(startIndex, deck.slides.length - 1));
}

/** Says what the current slide wants from the network while the deck may not load it. */
function updateRemoteNotice(prepared) {
  if (!player || player.allowRemote || prepared.remote.length === 0) {
    els.remoteNotice.hidden = true;
    return;
  }
  const hosts = [...new Set(prepared.remote.map(hostOf).filter(Boolean))];
  const count = prepared.remote.length;
  els.remoteText.textContent = `This slide wants to load ${count} item${count === 1 ? "" : "s"} from the internet (${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ", …" : ""}). Loading tells those sites you opened this deck.`;
  els.remoteNotice.hidden = false;
}

function hostOf(url) {
  try {
    return new URL(url, "https://invalid.invalid/").hostname;
  } catch {
    return null;
  }
}

let serverSettingsLoaded = false;

/** Reads the server's settings once (a deck opened by URL may arrive before the library has loaded). */
async function loadServerSettings() {
  if (serverSettingsLoaded) return;
  serverSettingsLoaded = true;
  try {
    const response = await fetch("/api/decks");
    if (response.ok) serverAllowsRemote = (await response.json()).allowRemote === true;
  } catch {
    /* no API: nothing is trusted */
  }
}

/** The overview's "about this deck" line: description, author, dates and keywords, as plain text. */
function renderAbout(info) {
  const parts = [];
  if (info.description) parts.push(info.description);
  const byline = [info.author, info.modified ? `updated ${formatDate(info.modified)}` : info.created ? `created ${formatDate(info.created)}` : null].filter(Boolean).join(" · ");
  if (byline) parts.push(byline);
  if (info.keywords.length) parts.push(info.keywords.map((k) => `#${k}`).join(" "));
  els.overviewAbout.textContent = parts.join(" — ");
  els.overviewAbout.hidden = parts.length === 0;
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function closeDeck({ push = true } = {}) {
  endPresenterLink();
  deckBytes = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (player) player.destroy();
  player = null;
  deck = null;
  deckUrl = null;
  closeOverview();
  if (push) history.pushState(null, "", "/");
  showHome();
}

// ─── Viewer ──────────────────────────────────────────────────────────────

function wirePlayer(p) {
  p.addEventListener("slidechange", (event) => {
    const { index, prepared } = event.detail;
    updateRemoteNotice(prepared);
    updateCounter();
    updateNotes(prepared);
    sendPosition();
    markOverviewCurrent();
    const hash = `#${index + 1}`;
    if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
  });
  p.addEventListener("stepchange", () => {
    updateCounter();
    sendPosition();
  });
  p.addEventListener("slideerror", (event) => toast(event.detail.message));
  p.addEventListener("slidewarning", (event) => console.warn(`[slidra] ${event.detail.message}`));
  p.addEventListener("escape", onEscape);
  p.addEventListener("key", (event) => {
    if (!handlePresenterKey(event.detail.key)) handleShortcut(event.detail.key);
    // The frame may have held its keys on its own (see the runtime); tell it the real state.
    syncHeldKeys();
  });
  p.addEventListener("pointer", poke);
  p.addEventListener("end", () => toast("End of the presentation."));
}

function wireViewer() {
  els.prev.addEventListener("click", () => {
    player && player.retreat();
    player && player.focusFrame();
  });
  els.next.addEventListener("click", () => {
    player && player.advance();
    player && player.focusFrame();
  });
  els.overviewButton.addEventListener("click", toggleOverview);
  els.overviewClose.addEventListener("click", closeOverview);
  els.notesButton.addEventListener("click", toggleNotes);
  els.fullscreenButton.addEventListener("click", toggleFullscreen);
  els.closeButton.addEventListener("click", () => closeDeck());
  els.blank.addEventListener("click", () => setBlank(null));
  els.presenterButton.addEventListener("click", openPresenterView);
  window.addEventListener("pagehide", endPresenterLink);
  els.keyHelpClose.addEventListener("click", closeKeyHelp);
  els.keyHelp.addEventListener("click", (event) => {
    if (event.target === els.keyHelp) closeKeyHelp();
  });
  els.remoteAllow.addEventListener("click", () => {
    els.remoteNotice.hidden = true;
    player && player.setAllowRemote(true);
    player && player.focusFrame();
  });

  window.addEventListener("resize", layoutStage);
  document.addEventListener("fullscreenchange", layoutStage);
  els.viewer.addEventListener("mousemove", poke);
  els.viewer.addEventListener("pointerdown", poke);

  document.addEventListener("keydown", (event) => {
    if (els.viewer.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea")) return;
    if (handlePresenterKey(event.key)) {
      event.preventDefault();
      return;
    }
    // Buttons keep their own Space/Enter.
    if ((event.key === " " || event.key === "Enter") && event.target instanceof HTMLButtonElement) return;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
      case " ":
      case "Enter":
        if (!els.overview.hidden) return;
        event.preventDefault();
        player && player.advance();
        return;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
      case "Backspace":
        if (!els.overview.hidden) return;
        event.preventDefault();
        player && player.retreat();
        return;
      case "Escape":
        event.preventDefault();
        onEscape();
        return;
    }
    if (handleShortcut(event.key)) event.preventDefault();
  });
}

/** Shortcuts shared by the host document and keys forwarded from the slide frame. Returns whether the key was used. */
function handleShortcut(key) {
  if (!player || !deck) return false;
  poke();
  switch (key) {
    case "Home":
      player.goTo(0);
      return true;
    case "End":
      player.goTo(deck.slides.length - 1, { startAt: "last" });
      return true;
    case "f":
    case "F":
      toggleFullscreen();
      return true;
    case "g":
    case "G":
    case "o":
    case "O":
      toggleOverview();
      return true;
    case "n":
    case "N":
      toggleNotes();
      return true;
    case "b":
    case "B":
    case ".":
      setBlank("black");
      return true;
    case "w":
    case "W":
    case ",":
      setBlank("white");
      return true;
    case "?":
      openKeyHelp();
      return true;
    case "p":
    case "P":
      openPresenterView();
      return true;
  }
  if (/^[0-9]$/.test(key)) {
    typeSlideNumber(key);
    return true;
  }
  return false;
}

// ─── Presenter view (playback §6.1) ─────────────────────────────────────
// This window stays the audience surface (it holds the user's gesture, so
// media plays with sound); the presenter view is a popup that receives the
// deck's bytes over a BroadcastChannel and then follows positions.

function openPresenterView() {
  if (!deck || !player || !deckBytes) return;
  if (presenter && !presenter.popup.closed) {
    presenter.popup.focus();
    return;
  }
  endPresenterLink();
  const id = newSessionId();
  const channel = new BroadcastChannel(CHANNEL_PREFIX + id);
  channel.addEventListener("message", (event) => onPresenterMessage(event.data));
  const popup = window.open(`/presenter?session=${id}`, `slidra-presenter-${id}`, "popup,width=1280,height=800");
  if (!popup) {
    channel.close();
    toast("The browser blocked the presenter window. Allow pop-ups for this site and press P again.");
    return;
  }
  presenter = { id, channel, popup, connected: false };
}

function onPresenterMessage(message) {
  if (!presenter || !message || typeof message.type !== "string") return;
  switch (message.type) {
    case "hello":
      presenter.channel.postMessage({ type: "deck", bytes: deckBytes.slice().buffer, fileName: deck.fileName, allowRemote: player.allowRemote });
      setPresenterConnected(true);
      sendPosition();
      return;
    case "key":
      if (typeof message.key === "string" && FORWARDED_KEYS.includes(message.key)) dispatchPresenterKey(message.key);
      return;
    case "bye":
      setPresenterConnected(false);
      presenter.channel.close();
      presenter = null;
  }
}

/** A key pressed in the presenter view, applied here as if pressed on the slide. */
function dispatchPresenterKey(key) {
  if (!player) return;
  if (!handlePresenterKey(key)) {
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) player.advance();
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) player.retreat();
    else if (key !== "Escape") handleShortcut(key);
  }
  syncHeldKeys();
}

function sendPosition() {
  if (!presenter || !presenter.connected || !player || !deck) return;
  presenter.channel.postMessage({ type: "position", index: player.index, step: player.step, total: deck.slides.length });
}

function setPresenterConnected(connected) {
  if (!presenter) return;
  presenter.connected = connected;
  // The audience surface never shows notes while a presenter view is open (playback §6.1).
  if (connected && !els.notesPanel.hidden) toggleNotesPanel(false);
  els.notesButton.disabled = connected;
  els.presenterButton.setAttribute("aria-pressed", String(connected));
}

function endPresenterLink() {
  if (!presenter) return;
  presenter.channel.postMessage({ type: "closed" });
  presenter.channel.close();
  presenter = null;
  if (els) {
    els.notesButton.disabled = false;
    els.presenterButton.setAttribute("aria-pressed", "false");
  }
}

// ─── Presenter keys (playback §1): blackout, go to slide, key help ──────

let blank = null;
let typedNumber = "";
let typedTimer = null;

/**
 * Keys that act on a presenter state rather than the slides: a blanked
 * surface, a slide number being typed, the key list. Returns whether the key
 * was used. The slide frame forwards every key while any of them is active.
 */
function handlePresenterKey(key) {
  if (!player || !deck) return false;
  if (!els.keyHelp.hidden) {
    if (key === "Escape" || key === "?" || key === "Enter") closeKeyHelp();
    return true;
  }
  if (blank) {
    if (["Shift", "Control", "Alt", "Meta"].includes(key)) return true;
    setBlank(null);
    return true;
  }
  if (typedNumber) {
    if (/^[0-9]$/.test(key)) typeSlideNumber(key);
    else if (key === "Enter") goToTypedSlide();
    else if (key === "Backspace") updateTypedNumber(typedNumber.slice(0, -1));
    else if (key === "Escape") updateTypedNumber("");
    else if (key !== "Shift") {
      updateTypedNumber("");
      return false;
    }
    return true;
  }
  return false;
}

function syncHeldKeys() {
  if (player) player.holdKeys(Boolean(blank || typedNumber || !els.keyHelp.hidden));
}

/** Blacks or whites out the audience surface (`null` restores it). */
function setBlank(kind) {
  blank = blank === kind ? null : kind;
  els.blank.hidden = !blank;
  els.blank.className = `blank${blank ? ` is-${blank}` : ""}`;
  els.viewer.classList.toggle("is-blank", Boolean(blank));
  syncHeldKeys();
  if (!blank && player) player.focusFrame();
}

function typeSlideNumber(digit) {
  updateTypedNumber((typedNumber + digit).replace(/^0+/, "").slice(0, 5));
}

function updateTypedNumber(value) {
  typedNumber = value;
  clearTimeout(typedTimer);
  els.goto.hidden = !typedNumber;
  els.gotoNumber.textContent = typedNumber;
  if (typedNumber) typedTimer = setTimeout(() => updateTypedNumber(""), 4000);
  syncHeldKeys();
}

function goToTypedSlide() {
  const n = Number(typedNumber);
  updateTypedNumber("");
  if (n >= 1) player.goTo(n - 1);
}

function openKeyHelp() {
  els.keyHelp.hidden = false;
  syncHeldKeys();
  els.keyHelpClose.focus();
}

function closeKeyHelp() {
  els.keyHelp.hidden = true;
  syncHeldKeys();
  player && player.focusFrame();
}

function onEscape() {
  if (handlePresenterKey("Escape")) return;
  if (!els.overview.hidden) closeOverview();
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else closeDeck();
}

/** Fits the slide to the stage at the deck's own aspect ratio. */
function layoutStage() {
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

function updateCounter() {
  if (!deck) return;
  const total = deck.slides.length;
  const index = player ? player.index : -1;
  els.counter.textContent = total === 0 ? "0 / 0" : `${index + 1} / ${total}`;
  els.prev.disabled = index <= 0 && (!player || player.step < 0);
  els.next.disabled = total === 0 || (index >= total - 1 && (!player || player.step >= player.stepCount - 1));

  const dots = [];
  const stepCount = player ? player.stepCount : 0;
  if (stepCount > 0 && stepCount <= 24) {
    for (let i = 0; i < stepCount; i++) {
      const dot = document.createElement("i");
      if (i <= player.step) dot.className = "on";
      dots.push(dot);
    }
  }
  els.stepDots.replaceChildren(...dots);

  const slideProgress = total === 0 ? 0 : (index + (stepCount > 0 ? (player.step + 1) / (stepCount + 1) : 0)) / Math.max(1, total - 1 + (stepCount > 0 ? 1 : 0));
  els.progressBar.style.width = `${Math.min(100, Math.max(0, slideProgress * 100))}%`;
}

function updateNotes(prepared) {
  const notes = prepared.notes;
  els.notesText.textContent = notes || "No speaker notes on this slide.";
  els.notesText.classList.toggle("is-empty", !notes);
  els.notesSlide.textContent = `Slide ${player.index + 1}`;
}

function toggleNotes() {
  if (presenter && presenter.connected) {
    toast("Speaker notes are in the presenter view while it is open.");
    return;
  }
  toggleNotesPanel(els.notesPanel.hidden);
}

function toggleNotesPanel(open) {
  els.notesPanel.hidden = !open;
  els.viewer.classList.toggle("notes-open", open);
  els.notesButton.setAttribute("aria-pressed", String(open));
  layoutStage();
  // Media overlays and embeds inside the frame re-align on its resize.
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.viewer.requestFullscreen();
  } catch (error) {
    toast(`Fullscreen is not available: ${error.message}`);
  }
  player && player.focusFrame();
}

/** Shows the controls, then hides them (and the cursor) after a quiet spell. */
function poke() {
  els.viewer.classList.remove("is-idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (els.overview.hidden && !els.viewer.hidden && !els.controls.matches(":hover")) els.viewer.classList.add("is-idle");
  }, IDLE_MS);
}

// ─── Overview ────────────────────────────────────────────────────────────

function toggleOverview() {
  if (els.overview.hidden) openOverview();
  else closeOverview();
}

function openOverview() {
  if (!deck || !player) return;
  els.overview.hidden = false;
  els.viewer.classList.remove("is-idle");
  const ratio = `${deck.canvas.width} / ${deck.canvas.height}`;
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const holder = /** @type {HTMLElement} */ (entry.target);
        thumbObserver.unobserve(holder);
        const index = Number(holder.dataset.index);
        const image = document.createElement("img");
        image.alt = "";
        holder.append(image);
        const current = player;
        current
          .thumbnail(index)
          .then((url) => {
            if (player !== current) return;
            image.src = url;
            const { title } = current.slide(index);
            if (title) labelOverviewItem(holder.closest(".overview-item"), index, title);
          })
          .catch(() => holder.classList.add("is-broken"));
      }
    },
    { root: els.overviewGrid, rootMargin: "400px" },
  );

  const items = deck.slides.map((path, index) => {
    const item = document.createElement("li");
    item.className = "overview-item";
    item.dataset.index = String(index);
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Slide ${index + 1}`);
    const thumb = document.createElement("div");
    thumb.className = "overview-thumb";
    thumb.style.aspectRatio = ratio;
    thumb.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "overview-label";
    const number = document.createElement("b");
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.textContent = path.split("/").pop();
    label.append(number, name);
    button.append(thumb, label);
    button.addEventListener("click", () => {
      closeOverview();
      player.goTo(index, { animate: false });
    });
    item.append(button);
    thumbObserver.observe(thumb);
    return item;
  });
  els.overviewGrid.replaceChildren(...items);
  markOverviewCurrent();
  const current = els.overviewGrid.querySelector(".is-current button");
  if (current) {
    current.focus();
    current.scrollIntoView({ block: "center" });
  }
}

/** Names an overview entry after its slide's title (spec §4.7) once the slide has been prepared. */
function labelOverviewItem(item, index, title) {
  if (!item) return;
  item.querySelector(".overview-label span").textContent = title;
  item.querySelector("button").setAttribute("aria-label", `Slide ${index + 1}: ${title}`);
}

function closeOverview() {
  if (els.overview.hidden) return;
  els.overview.hidden = true;
  thumbObserver?.disconnect();
  els.overviewGrid.replaceChildren();
  player && player.focusFrame();
  poke();
}

function markOverviewCurrent() {
  if (els.overview.hidden || !player) return;
  for (const item of els.overviewGrid.children) {
    item.classList.toggle("is-current", Number(item.dataset.index) === player.index);
  }
}

// ─── Drag & drop (anywhere on the page) ──────────────────────────────────

function wireDragAndDrop() {
  let depth = 0;
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes("Files");
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    els.dragVeil.hidden = false;
    els.dropzone.classList.add("is-over");
  });
  window.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      els.dragVeil.hidden = true;
      els.dropzone.classList.remove("is-over");
    }
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    els.dragVeil.hidden = true;
    els.dropzone.classList.remove("is-over");
    const file = event.dataTransfer.files[0];
    if (file) openFromFile(file);
  });
}

// ─── Small UI helpers ────────────────────────────────────────────────────

function showLoading(text) {
  els.loadingText.textContent = text;
  els.loading.hidden = false;
}

function hideLoading() {
  els.loading.hidden = true;
}

const recentToasts = new Map();

function toast(message) {
  // The same runtime error can repeat per step; show it once at a time.
  if (recentToasts.has(message)) return;
  const node = document.createElement("div");
  node.className = "toast";
  const text = document.createElement("span");
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  const dismiss = () => {
    node.remove();
    recentToasts.delete(message);
  };
  close.addEventListener("click", dismiss);
  node.append(text, close);
  els.toasts.append(node);
  recentToasts.set(message, setTimeout(dismiss, 6000));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
