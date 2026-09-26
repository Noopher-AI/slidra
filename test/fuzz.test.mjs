// Mutation fuzzing of the deck readers (format §17): whatever the bytes,
// openDeck must resolve or reject with a DeckError, quickly. Deterministic
// by default; FUZZ_ITERATIONS and FUZZ_SEED widen or vary a run
// (npm run fuzz does a long one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DeckError, openDeck } from "../lib/viewer/deck.js";

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 400);
const SEED = Number(process.env.FUZZ_SEED ?? 20260926);
const PER_CASE_MS = 2000;

const conformance = new URL("../conformance/decks/", import.meta.url);
const seeds = [
  ...["accept-minimal", "accept-legacy-zip-v4", "effects-all-options", "links"].map((id) => new Uint8Array(readFileSync(new URL(`${id}.slidra`, conformance)))),
  new Uint8Array(readFileSync(new URL("../examples/minimal.slidra", import.meta.url))),
];

/** A small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One mutation: flips, overwrites of header fields and pointers, truncation, splices. */
function mutate(input, random) {
  const bytes = new Uint8Array(input);
  const at = () => Math.floor(random() * bytes.length);
  const kind = Math.floor(random() * 7);
  if (kind === 0) {
    for (let i = 0, n = 1 + Math.floor(random() * 8); i < n; i++) bytes[at()] ^= 1 << Math.floor(random() * 8);
    return bytes;
  }
  if (kind === 1) return bytes.subarray(0, at());
  if (kind === 2) {
    // SQLite header fields (page size, reserved bytes, page count, encoding) or a ZIP header's sizes.
    const offsets = [16, 17, 20, 28, 29, 30, 31, 56, 60, 68, 100, 101, 103, 104, 105, 108, 109, 18, 22, 26, 28];
    const offset = offsets[Math.floor(random() * offsets.length)];
    if (offset < bytes.length) bytes[offset] = Math.floor(random() * 256);
    return bytes;
  }
  if (kind === 3) {
    const start = at();
    bytes.fill(0xff, start, Math.min(bytes.length, start + 1 + Math.floor(random() * 16)));
    return bytes;
  }
  if (kind === 4) {
    const start = at();
    bytes.fill(0, start, Math.min(bytes.length, start + 1 + Math.floor(random() * 64)));
    return bytes;
  }
  if (kind === 5) {
    // A 4-byte pointer somewhere past the header set to a large value.
    const offset = 100 + Math.floor(random() * Math.max(1, bytes.length - 104));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (offset + 4 <= bytes.length) view.setUint32(offset, Math.floor(random() * 0xffffffff));
    return bytes;
  }
  const a = at();
  const b = at();
  return new Uint8Array([...bytes.subarray(0, Math.min(a, b)), ...bytes.subarray(Math.max(a, b))]);
}

async function outcome(bytes) {
  const started = Date.now();
  try {
    await openDeck(bytes);
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - started };
  }
}

test(`openDeck survives ${ITERATIONS} mutated decks (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const random = rng(SEED);
  const failures = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const seed = seeds[i % seeds.length];
    const bytes = mutate(seed, random);
    const result = await outcome(bytes);
    if (!result.ok && !(result.error instanceof DeckError)) failures.push(`#${i}: ${result.error?.name}: ${result.error?.message}`);
    if (result.ms > PER_CASE_MS) failures.push(`#${i}: took ${result.ms} ms`);
    if (failures.length >= 10) break;
  }
  assert.deepEqual(failures, []);
});

test("every conformance deck opens or fails with a DeckError", async () => {
  for (const name of readdirSync(conformance)) {
    const result = await outcome(new Uint8Array(readFileSync(new URL(name, conformance))));
    assert.ok(result.ok || result.error instanceof DeckError, `${name}: ${result.error?.name}`);
  }
});
