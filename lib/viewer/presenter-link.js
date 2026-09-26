// The link between the audience window and a presenter view (playback
// §6.1): one BroadcastChannel per session, carrying the deck once and then
// positions and keys. Pure helpers here; lib/viewer/app.js (audience) and
// lib/viewer/presenter.js (presenter view) do the wiring.

export const CHANNEL_PREFIX = "slidra-presenter-";

/** Keys the presenter view may press on the audience window's behalf. Nothing that shows the audience a panel (G, N, ?) or needs a gesture there (F). */
export const FORWARDED_KEYS = Object.freeze([
  "ArrowRight",
  "ArrowDown",
  "PageDown",
  " ",
  "Enter",
  "ArrowLeft",
  "ArrowUp",
  "PageUp",
  "Backspace",
  "Home",
  "End",
  "b",
  "B",
  ".",
  "w",
  "W",
  ",",
  "Escape",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]);

/** A fresh, unguessable session id for a channel name. */
export function newSessionId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const isSessionId = (value) => typeof value === "string" && /^[0-9a-f]{24}$/.test(value);

/**
 * A position message from the audience window, checked for shape: a
 * channel is same-origin, but a message is still only data.
 * @returns {{ index: number, step: number, total: number } | null}
 */
export function readPosition(message) {
  if (!message || message.type !== "position") return null;
  const { index, step, total } = message;
  if (![index, step, total].every(Number.isInteger) || index < 0 || step < -1 || total < 0 || index >= Math.max(total, 1)) return null;
  return { index, step, total };
}

/**
 * How a presenter view's copy of the deck catches up with the audience:
 * one step forward on the same slide plays that step (so the presenter sees
 * the animation); any other difference jumps straight to the position.
 * @param {{ index: number, step: number }} current where the copy is
 * @param {{ index: number, step: number }} target where the audience is
 * @returns {{ kind: "none" } | { kind: "advance" } | { kind: "show", index: number, step: number }}
 */
export function catchUp(current, target) {
  if (current.index === target.index && current.step === target.step) return { kind: "none" };
  if (current.index === target.index && target.step === current.step + 1) return { kind: "advance" };
  return { kind: "show", index: target.index, step: target.step };
}

/**
 * What the presenter sees as "next" (playback §6.1): the rest of this slide
 * while it has steps left, else the next slide, else the end.
 * @returns {{ kind: "step", index: number, step: number, steps: number } | { kind: "slide", index: number } | { kind: "end" }}
 */
export function nextPosition({ index, step, stepCount, total }) {
  if (step < stepCount - 1) return { kind: "step", index, step: step + 1, steps: stepCount };
  if (index < total - 1) return { kind: "slide", index: index + 1 };
  return { kind: "end" };
}

/** `mm:ss`, or `h:mm:ss` past the hour. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
