import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { checkAttributes, checkProject, metadataSchema } from "../lib/schema.js";
import { NAMESPACE, openDeck, readProject } from "../lib/viewer/deck.js";
import { parseLink } from "../lib/viewer/links.js";
import { ENTER_TRANSITION_EFFECTS, SUPPORTED_EFFECTS, SUPPORTED_STARTS, TRANSITION_EFFECTS, validateEffect, validateTransition } from "../lib/viewer/effects.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const attributesOf = (el) => Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value]).filter(([name]) => !name.startsWith("xmlns")));

// ── project.json ──────────────────────────────────────────────────────

const base = { formatVersion: 5, name: "Deck", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] };
const font = { file: "fonts/A.ttf", family: "A", license: "OFL-1.1", licenseFile: "fonts/OFL.txt", source: "https://example.com" };

/** Projects a reader MUST reject (spec §1.4, §2). Schema and viewer agree on every one. */
const readerRejects = [
  { ...base, formatVersion: 6 },
  { ...base, formatVersion: "5" },
  { ...base, name: 5 },
  { ...base, canvas: { width: 0, height: 720 } },
  { ...base, canvas: { width: 1280 } },
  { ...base, slides: "slides/001.svg" },
  { ...base, slides: ["/slides/001.svg"] },
  { ...base, slides: ["slides/../001.svg"] },
  { ...base, slides: ["slides\\001.svg"] },
  { ...base, slides: ["slides//001.svg"] },
  { ...base, slides: ["./slides/001.svg"] },
  { ...base, fonts: {} },
  { ...base, fonts: [{ ...font, file: "../A.ttf" }] },
  (({ name: _name, ...rest }) => rest)(base),
];

/** Valid projects. */
const valid = [
  base,
  { ...base, slides: [] },
  { ...base, fonts: [font] },
  { ...base, futureField: { kept: true } },
  { ...base, templates: ["templates/001.svg", { file: "templates/002.svg", name: "Title" }] },
];

/** Rules only a writer is held to (document metadata §2.1; every FontEntry field §2.2; templates are not read during playback). Readers accept these. */
const writerOnly = [
  { ...base, lang: "not a language!" },
  { ...base, author: 42 },
  { ...base, created: "yesterday" },
  { ...base, keywords: "a, b" },
  { ...base, cover: "../slides/001.svg" },

  { ...base, fonts: [{ file: "fonts/A.ttf", family: "A" }] },
  { ...base, templates: [{ name: "no file" }] },
];

function entriesFor(project) {
  const entries = new Map([["project.json", new TextEncoder().encode(JSON.stringify(project))]]);
  const slides = Array.isArray(project.slides) ? project.slides : [];
  for (const slide of slides) if (typeof slide === "string") entries.set(slide, new Uint8Array(1));
  return entries;
}

const readerAccepts = (project) => {
  try {
    readProject(entriesFor(project), "sqlite");
    return true;
  } catch {
    return false;
  }
};

test("project.json: schema and viewer reject the same invalid projects", () => {
  for (const project of readerRejects) {
    assert.notDeepEqual(checkProject(project), [], `schema should reject ${JSON.stringify(project)}`);
    assert.equal(readerAccepts(project), false, `viewer should reject ${JSON.stringify(project)}`);
  }
});

test("project.json: schema and viewer accept the same valid projects", () => {
  for (const project of valid) {
    assert.deepEqual(checkProject(project), [], JSON.stringify(project));
    assert.equal(readerAccepts(project), true, JSON.stringify(project));
  }
});

test("project.json: writer-only rules are enforced by the schema, not by readers", () => {
  for (const project of writerOnly) {
    assert.notDeepEqual(checkProject(project), [], JSON.stringify(project));
    assert.equal(readerAccepts(project), true, JSON.stringify(project));
  }
});

// ── Slide vocabulary ──────────────────────────────────────────────────

const effectDef = metadataSchema.$defs.effect;

test("the schema's effect vocabulary is exactly the viewer's", () => {
  assert.deepEqual(effectDef.properties.family.enum, Object.keys(SUPPORTED_EFFECTS));
  assert.deepEqual(effectDef.properties.start.enum, SUPPORTED_STARTS);
  for (const branch of effectDef.allOf) {
    const family = branch.if.properties.family.const;
    const effects = branch.then.properties.effect.enum ?? [branch.then.properties.effect.const];
    assert.deepEqual(effects, SUPPORTED_EFFECTS[family], family);
  }
  assert.deepEqual(metadataSchema.$defs.transitionEffect.enum, TRANSITION_EFFECTS);
  assert.deepEqual(metadataSchema.$defs.enterTransitionEffect.enum, ENTER_TRANSITION_EFFECTS);
});

const effect = (extra) => ({ target: "el-a", family: "enter", effect: "fade", start: "on-click", ...extra });
/** @type {[Record<string, string>, boolean][]} */
const effectCases = [
  [effect(), true],
  [effect({ duration: "0.6", delay: "0" }), true],
  [effect({ duration: " 1.5 " }), true],
  [effect({ duration: ".5" }), true],
  [effect({ duration: "2." }), true],
  [effect({ family: "path", effect: "path", d: "M0 0 L10 0" }), true],
  [effect({ family: "media", effect: "play" }), true],
  [effect({ duration: "" }), false],
  [effect({ duration: "-1" }), false],
  [effect({ duration: "0x10" }), false],
  [effect({ duration: "1e3" }), false],
  [effect({ delay: "Infinity" }), false],
  [effect({ effect: "spin" }), false],
  [effect({ family: "wobble" }), false],
  [effect({ start: "later" }), false],
  [effect({ family: "path", effect: "path" }), false],
  [effect({ family: "path", effect: "path", d: "" }), false],
  [effect({ target: "" }), false],
  [effect({ effect: "fly-down", easing: "overshoot" }), true],
  [effect({ family: "exit", effect: "fly-out-left", by: "word", stagger: "0.05" }), true],
  [effect({ family: "emphasis", effect: "spin", repeat: "3", easing: "linear" }), true],
  [effect({ trigger: "el-t" }), true],
  [effect({ easing: "bouncy" }), false],
  [effect({ family: "media", effect: "play", easing: "linear" }), false],
  [effect({ repeat: "2" }), false],
  [effect({ family: "emphasis", effect: "pulse", repeat: "0" }), false],
  [effect({ family: "emphasis", effect: "pulse", by: "word" }), false],
  [effect({ by: "sentence" }), false],
  [effect({ stagger: "0.1" }), false],
  [(({ start: _start, ...rest }) => rest)(effect()), false],
];

test("effects: schema and viewer give the same verdict", () => {
  for (const [attrs, ok] of effectCases) {
    assert.equal(checkAttributes("effect", attrs).length === 0, ok, `schema: ${JSON.stringify(attrs)}`);
    const raw = { target: null, family: null, effect: null, start: null, duration: null, delay: null, d: null, easing: null, repeat: null, by: null, stagger: null, trigger: null, ...attrs };
    let viewerOk = true;
    try {
      validateEffect(raw, 0, true);
    } catch {
      viewerOk = false;
    }
    assert.equal(viewerOk, ok, `viewer: ${JSON.stringify(attrs)}`);
  }
});

/** @type {[Record<string, string>, boolean][]} */
const transitionCases = [
  [{}, true],
  [{ enter: "fade", "enter-duration": "0.3", exit: "slide", "exit-duration": "0" }, true],
  [{ enter: "spiral" }, false],
  [{ enter: "morph", "enter-duration": "0.8" }, true],
  [{ exit: "morph" }, false],
  [{ "exit-duration": "" }, false],
  [{ "enter-duration": "-0.1" }, false],
];

test("transitions: schema and viewer give the same verdict", () => {
  for (const [attrs, ok] of transitionCases) {
    assert.equal(checkAttributes("transition", attrs).length === 0, ok, `schema: ${JSON.stringify(attrs)}`);
    let viewerOk = true;
    try {
      validateTransition(attrs);
    } catch {
      viewerOk = false;
    }
    assert.equal(viewerOk, ok, `viewer: ${JSON.stringify(attrs)}`);
  }
});

test("link values: the schema and the viewer's parser agree", () => {
  for (const value of [
    "https://slidra.app/spec",
    "mailto:a@example.com",
    "#s-Q2xpY2tNZTEy",
    "#next",
    "#previous",
    "#first",
    "#last",
    "javascript:alert(1)",
    "data:x",
    "slides/002.svg",
    "#s-short",
    "#home",
  ]) {
    const schemaOk = checkAttributes("element", { id: "el-Ab3xK9mQ2pLw", "data-slidra-link": value }).length === 0;
    assert.equal(schemaOk, parseLink(value) !== null, value);
  }
});

test("other vocabulary definitions accept conforming markup and reject the rest", () => {
  assert.deepEqual(checkAttributes("comment", { id: "c-01", target: "page", created: "2026-09-01T00:00:00.000Z" }), []);
  assert.notDeepEqual(checkAttributes("comment", { id: "c-01", target: "page", created: "yesterday" }), []);
  assert.deepEqual(checkAttributes("chart", { type: "bar", width: "480", height: "320", stacked: "true" }), []);
  assert.notDeepEqual(checkAttributes("chart", { type: "pie", width: "480", height: "320", stacked: "true" }), []);
  assert.notDeepEqual(checkAttributes("chart", { type: "bar", width: "0", height: "320" }), []);
  assert.deepEqual(checkAttributes("series", { name: "Revenue", values: "100, 120,140", axis: "left", color: "#C8233B" }), []);
  assert.notDeepEqual(checkAttributes("series", { name: "Revenue", values: "100,,140" }), []);
  assert.deepEqual(checkAttributes("element", { id: "el-Ab3xK9mQ2pLw", "data-slidra-text-align": "center", "data-slidra-future": "kept" }), []);
  assert.notDeepEqual(checkAttributes("element", { id: "el-short" }), []);
  assert.notDeepEqual(checkAttributes("element", { id: "el-Ab3xK9mQ2pLw", "data-slidra-role": "background" }), []);
  assert.deepEqual(checkAttributes("cell", { "data-slidra-cell": "0,1", "data-slidra-span": "1,2" }), []);
  assert.deepEqual(checkAttributes("slide", { "data-slidra-slide-id": "s-Q2xpY2tNZTEy" }), []);
  assert.notDeepEqual(checkAttributes("slide", { "data-slidra-slide-id": "slide-1" }), []);
  assert.notDeepEqual(checkAttributes("cell", { "data-slidra-cell": "0,1", "data-slidra-span": "0,2" }), []);
});

// ── The example decks conform ─────────────────────────────────────────

for (const name of readdirSync(new URL("../examples/", import.meta.url)).filter((file) => file.endsWith(".slidra"))) {
  test(`examples/${name} conforms to both schemas`, async () => {
    const deck = await openDeck(new Uint8Array(readFileSync(new URL(`../examples/${name}`, import.meta.url))));
    assert.deepEqual(checkProject(deck.project), []);
    for (const path of deck.slides) {
      const root = new DOMParser().parseFromString(deck.readText(path), "image/svg+xml").documentElement;
      const check = (definition, el) => assert.deepEqual(checkAttributes(definition, attributesOf(el)), [], `${path}: <${el.tagName} ${JSON.stringify(attributesOf(el))}>`);
      for (const definition of ["effect", "transition", "notes", "comment", "chart", "series", "categories", "source"]) {
        for (const el of Array.from(root.getElementsByTagNameNS(NAMESPACE, definition))) check(definition, el);
      }
      for (const el of Array.from(root.getElementsByTagNameNS(SVG_NS, "g"))) {
        const id = el.getAttribute("id");
        if (id && id.startsWith("el-")) check("element", el);
        if (el.hasAttribute("data-slidra-cell")) check("cell", el);
      }
    }
  });
}
