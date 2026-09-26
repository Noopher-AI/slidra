import { test } from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../lib/viewer/lru.js";
import { openDeck } from "../lib/viewer/deck.js";
import { makeDeck, svg } from "./fixtures/make-deck.mjs";

test("evicts the least recently used entries past capacity, reporting each", () => {
  const evicted = [];
  const cache = new LruCache(3, undefined, (key) => evicted.push(key));
  cache.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(cache.get("a"), 1, "reading a makes it the most recent");
  cache.set("d", 4);
  assert.deepEqual(evicted, ["b"]);
  assert.deepEqual([...cache.map.keys()], ["c", "a", "d"]);
  assert.equal(cache.get("b"), undefined);
});

test("a cost function bounds the total, and one oversized entry still fits alone", () => {
  const cache = new LruCache(10, (value) => value.length);
  cache.set("a", "12345").set("b", "12345");
  assert.equal(cache.total, 10);
  cache.set("c", "123");
  assert.deepEqual([...cache.map.keys()], ["b", "c"]);
  cache.set("huge", "x".repeat(50));
  assert.deepEqual([...cache.map.keys()], ["huge"]);
  assert.equal(cache.total, 50);
  cache.set("huge", "y");
  assert.equal(cache.total, 1, "replacing a key replaces its cost");
  cache.clear();
  assert.deepEqual([cache.size, cache.total], [0, 0]);
});

test("a deck's data: URLs are cached, bounded and rebuilt on demand", async () => {
  const deck = await openDeck(makeDeck({ slides: [svg("<g/>")], files: { "assets/a.bin": new Uint8Array(3000), "assets/b.bin": new Uint8Array(3000) } }));
  assert.ok(deck.dataUrls instanceof LruCache);
  const first = deck.dataUrl("assets/a.bin");
  assert.equal(deck.dataUrl("assets/a.bin"), first);
  deck.dataUrls.capacity = first.length + 10;
  deck.dataUrl("assets/b.bin");
  assert.equal(deck.dataUrls.has("assets/a.bin"), false, "a fell out when b came in");
  assert.equal(deck.dataUrl("assets/a.bin"), first, "and comes back identical");
});
