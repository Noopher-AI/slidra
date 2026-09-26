import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLink, slideIdOf } from "../lib/viewer/links.js";
import { openDeck } from "../lib/viewer/deck.js";
import { makeDeck, svg } from "./fixtures/make-deck.mjs";

test("parses the link kinds the spec defines", () => {
  assert.deepEqual(parseLink("https://slidra.app/spec"), { kind: "external", url: "https://slidra.app/spec" });
  assert.deepEqual(parseLink(" http://example.com "), { kind: "external", url: "http://example.com/" });
  assert.deepEqual(parseLink("mailto:team@example.com"), { kind: "external", url: "mailto:team@example.com" });
  assert.deepEqual(parseLink("#s-Q2xpY2tNZTEy"), { kind: "slide", slideId: "s-Q2xpY2tNZTEy" });
  for (const action of ["next", "previous", "first", "last"]) assert.deepEqual(parseLink(`#${action}`), { kind: "action", action });
});

test("ignores every other value", () => {
  for (const value of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "file:///etc/passwd", "slides/002.svg", "../x", "#s-short", "#home", "#", "", "  ", null, undefined]) {
    assert.equal(parseLink(value), null, String(value));
  }
});

test("reads a slide id from the root start tag only", () => {
  assert.equal(
    slideIdOf(
      '<?xml version="1.0"?><!-- <svg data-slidra-slide-id="s-AAAAAAAAAAAA"> --><svg xmlns="http://www.w3.org/2000/svg" data-slidra-slide-id=\'s-BBBBBBBBBBBB\'><g data-slidra-slide-id="s-CCCCCCCCCCCC"/></svg>',
    ),
    "s-BBBBBBBBBBBB",
  );
  assert.equal(slideIdOf('<svg xmlns="http://www.w3.org/2000/svg"><g data-slidra-slide-id="s-CCCCCCCCCCCC"/></svg>'), null);
  assert.equal(slideIdOf('<svg data-slidra-slide-id="not-an-id"/>'), null);
});

test("a deck resolves slide ids to positions, the first of duplicates winning", async () => {
  const deck = await openDeck(
    makeDeck({
      slides: [
        svg("", { attrs: ' data-slidra-slide-id="s-AAAAAAAAAAAA"' }),
        svg(""),
        svg("", { attrs: ' data-slidra-slide-id="s-CCCCCCCCCCCC"' }),
        svg("", { attrs: ' data-slidra-slide-id="s-AAAAAAAAAAAA"' }),
      ],
    }),
  );
  assert.equal(deck.slideIndexById("s-AAAAAAAAAAAA"), 0);
  assert.equal(deck.slideIndexById("s-CCCCCCCCCCCC"), 2);
  assert.equal(deck.slideIndexById("s-ZZZZZZZZZZZZ"), -1);
});
