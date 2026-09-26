// Printing and PDF export (playback §8): every slide as its static SVG,
// drawn as an SVG *image* (vector in the printout, no script, no network),
// laid out one per page, as notes pages, or as handouts. The browser's own
// print dialog does the rest, "Save as PDF" included.

import { cssEscapeId } from "./effects.js";
import { thumbnailSvg } from "./thumbnail.js";

/**
 * @typedef {"slides" | "handout-2" | "handout-3" | "handout-6"} PrintLayout
 * @typedef {{ layout: PrintLayout, notes: boolean, steps: boolean }} PrintOptions
 */

export const PER_PAGE = Object.freeze({ slides: 1, "handout-2": 2, "handout-3": 3, "handout-6": 6 });

/**
 * The ids hidden after steps `0 … step` have run (playback §8): pre-hidden
 * elements that have not entered yet, and elements an exit has taken away.
 * Emphasis and motion paths leave nothing hidden. `step` -1 is the opening state.
 * @param {{ hidden: string[], steps: { effects: { target: string, family: string }[] }[] }} plan
 * @param {number} step
 * @returns {Set<string>}
 */
export function hiddenAfterStep(plan, step) {
  const hidden = new Set(plan.hidden);
  for (let s = 0; s <= step && s < plan.steps.length; s++) {
    for (const effect of plan.steps[s].effects) {
      if (effect.family === "enter") hidden.delete(effect.target);
      else if (effect.family === "exit") hidden.add(effect.target);
    }
  }
  return hidden;
}

/**
 * The pages to print, in order: one entry per slide, or per step of each
 * slide when `steps` is set (a slide with no steps still prints once).
 * @returns {{ index: number, step: number | null }[]}
 */
export function printEntries(slides, { steps }) {
  const entries = [];
  slides.forEach(({ plan }, index) => {
    const count = steps && plan ? plan.steps.length : 0;
    if (count === 0) entries.push({ index, step: null });
    else for (let step = 0; step < count; step++) entries.push({ index, step });
  });
  return entries;
}

/** `markup` with the given ids hidden by a style rule (the ids come from the deck: escaped). */
function hideIds(markup, ids) {
  if (ids.size === 0) return markup;
  const rules = [...ids].map((id) => `#${cssEscapeId(id)}{opacity:0 !important}`).join("");
  return markup.replace(/^(<svg\b[^>]*>)/, (tag) => `${tag}<style>${rules}</style>`);
}

/**
 * Builds the print layout for a deck and resolves once every image has
 * decoded. The caller calls window.print() and then `dispose()`.
 * @param {{ canvas: { width: number, height: number }, slides: string[], name: string }} deck
 * @param {(index: number) => { markup: string, plan: any, notes: string, title: string | null }} slide prepared slide getter
 * @param {string} fontCss @font-face rules for the deck's fonts
 * @param {PrintOptions} options
 */
export async function buildPrintout(deck, slide, fontCss, options) {
  const prepared = deck.slides.map((_, index) => slide(index));
  const entries = printEntries(prepared, options);
  const perPage = PER_PAGE[options.layout] ?? 1;
  const urls = [];
  const root = document.createElement("div");
  root.id = "print-root";
  root.className = `print-root print-${options.layout}${options.notes ? " with-notes" : ""}`;
  root.setAttribute("aria-hidden", "true");

  const style = document.createElement("style");
  // One slide per page, without notes: the page is the canvas. Everything else prints on A4.
  const canvasPages = options.layout === "slides" && !options.notes;
  style.textContent = canvasPages ? `@page{size:${deck.canvas.width}px ${deck.canvas.height}px;margin:0}` : "@page{size:A4 portrait;margin:14mm}";
  root.append(style);

  const images = [];
  let page = null;
  entries.forEach((entry, n) => {
    if (n % perPage === 0) {
      page = document.createElement("section");
      page.className = "print-page";
      root.append(page);
    }
    const data = prepared[entry.index];
    const markup = entry.step === null || !data.plan ? data.markup : hideIds(data.markup, hiddenAfterStep(data.plan, entry.step));
    const svg = thumbnailSvg(markup, fontCss);
    const figure = document.createElement("figure");
    figure.className = "print-slide";
    const image = document.createElement("img");
    image.alt = "";
    image.style.aspectRatio = `${deck.canvas.width} / ${deck.canvas.height}`;
    if (svg) {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      urls.push(url);
      image.src = url;
      images.push(image);
    }
    const caption = document.createElement("figcaption");
    const label = `${entry.index + 1}${entry.step === null ? "" : ` · step ${entry.step + 1}`}${data.title ? ` — ${data.title}` : ""}`;
    caption.textContent = label;
    figure.append(image, caption);
    if (options.notes && data.notes && (entry.step === null || entry.step === (data.plan ? data.plan.steps.length - 1 : 0))) {
      const notes = document.createElement("p");
      notes.className = "print-notes";
      notes.textContent = data.notes;
      figure.append(notes);
    }
    page.append(figure);
  });

  document.body.append(root);
  await Promise.all(images.map((image) => image.decode().catch(() => {})));
  return {
    root,
    pages: root.querySelectorAll(".print-page").length,
    dispose() {
      root.remove();
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}
