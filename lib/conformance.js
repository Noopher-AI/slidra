// The reference reader's verdict on a deck, in the shape the conformance
// manifest (conformance/manifest.json) states expectations in. Node-only:
// slides are parsed with lib/node-dom.js.

import { nodeDom } from "./node-dom.js";
import { openDeck } from "./viewer/deck.js";
import { prepareSlide, useDom } from "./viewer/slide.js";

useDom(nodeDom);

/**
 * @typedef {{ status: "ok" | "corrupt", error: string | null, warnings: string[], steps: number, hidden: string[], triggers: Record<string, number>, enter: string, links: string[], title: string | null, lang: string | null }} SlideVerdict
 * @typedef {{ open: "accept", slides: SlideVerdict[], deck: import("./viewer/deck.js").Deck } | { open: "reject", reason: string }} Verdict
 */

/** @returns {Promise<Verdict>} */
export async function evaluateDeck(bytes, fileName = "deck.slidra") {
  let deck;
  try {
    deck = await openDeck(bytes, { fileName });
  } catch (error) {
    return { open: "reject", reason: error.message };
  }
  const slides = deck.slides.map((_, index) => {
    const prepared = prepareSlide(deck, index);
    const plan = prepared.plan;
    return {
      status: plan ? "ok" : "corrupt",
      error: prepared.error,
      warnings: prepared.warnings,
      steps: plan ? plan.steps.length : 0,
      hidden: plan ? [...plan.hidden] : [],
      triggers: plan ? Object.fromEntries(Object.entries(plan.triggers).map(([id, steps]) => [id, steps.length])) : {},
      enter: prepared.transition.enter.effect,
      links: Object.keys(prepared.links),
      title: prepared.title,
      lang: prepared.lang,
    };
  });
  return { open: "accept", slides, deck };
}

/**
 * Differences between an expectation and a verdict, as readable lines; only
 * the fields the expectation states are compared.
 */
export function compareVerdict(expect, verdict) {
  const problems = [];
  if (expect.open !== verdict.open) {
    problems.push(`expected the deck to be ${expect.open}ed, but it was ${verdict.open}ed${verdict.open === "reject" ? ` (${verdict.reason})` : ""}`);
    return problems;
  }
  if (expect.open === "reject" || verdict.open === "reject") return problems;
  if (expect.slides.length !== verdict.slides.length) problems.push(`expected ${expect.slides.length} slides, found ${verdict.slides.length}`);
  expect.slides.forEach((wanted, i) => {
    const got = verdict.slides[i];
    if (!got) return;
    for (const [key, value] of Object.entries(wanted)) {
      if (JSON.stringify(got[key]) !== JSON.stringify(value))
        problems.push(`slide ${i + 1}: expected ${key} ${JSON.stringify(value)}, got ${JSON.stringify(got[key])}${got.error ? ` (${got.error})` : ""}`);
    }
  });
  return problems;
}
