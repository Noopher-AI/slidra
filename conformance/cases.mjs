// The .slidra conformance cases: small decks, each with the verdict a
// conforming reader must reach. tools/build-conformance.mjs turns this file
// into conformance/decks/*.slidra and conformance/manifest.json, which is
// what other implementations consume; see conformance/README.md.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";
import { DeckWriter } from "../lib/writer/index.js";

const NS = "https://slidra.app/ns/2026";

const svg = (body, { metadata = "", attrs = "" } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="${NS}" viewBox="0 0 1280 720"${attrs}>${metadata ? `<metadata>${metadata}</metadata>` : ""}${body}</svg>`;
const effects = (...list) => `<slidra:effects xmlns:slidra="${NS}">${list.join("")}</slidra:effects>`;
const fx = (attrs) =>
  `<slidra:effect ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}/>`;
const box = (id, extra = "") => `<g id="${id}"${extra}><rect x="100" y="100" width="200" height="100"/><text x="110" y="160">${id}</text></g>`;
const A = "el-AAAAAAAAAAAA";
const B = "el-BBBBBBBBBBBB";
const C = "el-CCCCCCCCCCCC";

/** Builds a deck with the reference writer; `validate: false` for decks that break writer rules on purpose. */
function deck({ slides, project = {}, files = {}, validate = true }) {
  const writer = new DeckWriter({ name: "Conformance", ...project });
  for (const slide of slides) writer.addSlide(slide);
  for (const [entry, data] of Object.entries(files)) writer.addFile(entry, data);
  return withTemp((file) => writer.write(file, { validate }));
}

/** A SQLite container built row by row, for container-level breakage the writer refuses to produce. */
function rawSqlite({ applicationId = 0x536c6472, userVersion = 5, table = "content", rows }) {
  return withTemp((file) => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(`PRAGMA application_id = ${applicationId}`);
    db.exec(`PRAGMA user_version = ${userVersion}`);
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind INTEGER NOT NULL, data BLOB)`);
    const insert = db.prepare(`INSERT INTO ${table} (path, kind, data) VALUES (?, ?, ?)`);
    for (const [entry, data] of rows) insert.run(entry, data === null ? 1 : 0, data === null ? null : Buffer.from(data));
    db.close();
  });
}

function withTemp(write) {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-conformance-"));
  try {
    const file = path.join(dir, "deck.slidra");
    write(file);
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A legacy ZIP container (deflated entries). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const body = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const size = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const project = (fields = {}) => JSON.stringify({ formatVersion: 5, name: "Conformance", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"], ...fields });
const baseRows = (json = project()) => [
  ["slides", null],
  ["assets", null],
  ["fonts", null],
  ["slides/001.svg", svg(box(A))],
  ["project.json", json],
];

/** One slide whose effect list is `list` (and body holds A, B and C). */
const slideWith = (list, extra = {}) => deck({ slides: [svg(box(A) + box(B) + box(C) + (extra.body ?? ""), { metadata: list + (extra.metadata ?? "") })] });
/** @returns {Case} */
const corruptEffect = (id, rule, description, list, extra = undefined) => ({
  id,
  rule,
  description,
  build: () => slideWith(effects(...list), extra),
  expect: { open: "accept", slides: [{ status: "corrupt" }] },
});

/**
 * @typedef {{ status?: "ok" | "corrupt", steps?: number, hidden?: string[], triggers?: Record<string, number>, enter?: string, links?: string[], title?: string | null, lang?: string | null }} SlideExpectation
 * @typedef {{ open: "accept", slides: SlideExpectation[] } | { open: "reject" }} Expectation
 * @typedef {{ id: string, rule: string, description: string, build: () => Uint8Array, expect: Expectation }} Case
 * @type {Case[]}
 */
export const CASES = [
  // ── Container and project.json: readers MUST reject ─────────────────
  {
    id: "container-not-a-deck",
    rule: "format §1.1",
    description: "Neither a SQLite nor a ZIP header.",
    build: () => new TextEncoder().encode("just some text, not a deck"),
    expect: { open: "reject" },
  },
  {
    id: "container-foreign-application-id",
    rule: "format §1.1",
    description: "A SQLite file whose application_id is neither Sldr nor 0.",
    build: () => rawSqlite({ applicationId: 0x12345678, rows: baseRows() }),
    expect: { open: "reject" },
  },
  {
    id: "container-user-version-mismatch",
    rule: "format §1.1",
    description: "user_version 4 while project.json says formatVersion 5.",
    build: () => rawSqlite({ userVersion: 4, rows: baseRows() }),
    expect: { open: "reject" },
  },
  {
    id: "container-no-content-table",
    rule: "format §1.1",
    description: "The rows live in a table not called content.",
    build: () => rawSqlite({ table: "files", rows: baseRows() }),
    expect: { open: "reject" },
  },
  {
    id: "container-unsafe-path",
    rule: "format §1.4",
    description: "A row whose path climbs out of the deck (../evil.txt).",
    build: () => rawSqlite({ rows: [...baseRows(), ["../evil.txt", "x"]] }),
    expect: { open: "reject" },
  },
  {
    id: "container-backslash-path",
    rule: "format §1.4",
    description: "A row whose path contains a backslash.",
    build: () => rawSqlite({ rows: [...baseRows(), ["assets\\evil.txt", "x"]] }),
    expect: { open: "reject" },
  },
  {
    id: "container-zip-claims-v5",
    rule: "format §1.2",
    description: "A ZIP container whose project.json says formatVersion 5.",
    build: () =>
      zip([
        ["project.json", project()],
        ["slides/001.svg", svg(box(A))],
      ]),
    expect: { open: "reject" },
  },
  { id: "project-not-json", rule: "format §2", description: "project.json is not JSON.", build: () => rawSqlite({ rows: baseRows("{ name: nope") }), expect: { open: "reject" } },
  {
    id: "project-missing",
    rule: "format §1.3",
    description: "No project.json at all.",
    build: () => rawSqlite({ rows: baseRows().filter(([p]) => p !== "project.json") }),
    expect: { open: "reject" },
  },
  { id: "project-format-version-6", rule: "format §2", description: "formatVersion 6.", build: () => rawSqlite({ rows: baseRows(project({ formatVersion: 6 })) }), expect: { open: "reject" } },
  {
    id: "project-name-missing",
    rule: "format §2",
    description: "project.json has no name.",
    build: () => rawSqlite({ rows: baseRows(JSON.stringify({ formatVersion: 5, canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] })) }),
    expect: { open: "reject" },
  },
  {
    id: "project-canvas-zero",
    rule: "format §2",
    description: "A canvas with zero width.",
    build: () => rawSqlite({ rows: baseRows(project({ canvas: { width: 0, height: 720 } })) }),
    expect: { open: "reject" },
  },
  {
    id: "project-slide-missing",
    rule: "format §2",
    description: "slides lists a file the deck does not have.",
    build: () => rawSqlite({ rows: baseRows(project({ slides: ["slides/001.svg", "slides/002.svg"] })) }),
    expect: { open: "reject" },
  },
  {
    id: "project-slide-path-escapes",
    rule: "format §1.4",
    description: "slides lists ../slides/001.svg.",
    build: () => rawSqlite({ rows: baseRows(project({ slides: ["../slides/001.svg"] })) }),
    expect: { open: "reject" },
  },

  // ── Readers MUST accept ─────────────────────────────────────────────
  {
    id: "accept-minimal",
    rule: "format §2",
    description: "One slide, no effects.",
    build: () => deck({ slides: [svg(box(A))] }),
    expect: { open: "accept", slides: [{ status: "ok", steps: 0, hidden: [] }] },
  },
  { id: "accept-no-slides", rule: "format §2", description: "An empty slides array.", build: () => deck({ slides: [] }), expect: { open: "accept", slides: [] } },
  {
    id: "accept-unknown-fields-and-tables",
    rule: "format §1.1, §2",
    description: "application_id 0, an unknown project.json field and an extra table: all tolerated.",
    build: () =>
      withTemp((file) => {
        writeFileSync(file, rawSqlite({ applicationId: 0, rows: baseRows(project({ vendorField: { kept: true } })) }));
        const db = new DatabaseSync(file);
        db.exec("CREATE TABLE undo_history (id INTEGER PRIMARY KEY, op TEXT)");
        db.close();
      }),
    expect: { open: "accept", slides: [{ status: "ok" }] },
  },
  {
    id: "accept-legacy-zip-v4",
    rule: "format §1.2",
    description: "A legacy ZIP deck at formatVersion 4.",
    build: () =>
      zip([
        ["project.json", project({ formatVersion: 4 })],
        ["slides/001.svg", svg(box(A))],
      ]),
    expect: { open: "accept", slides: [{ status: "ok" }] },
  },
  {
    id: "accept-lenient-metadata",
    rule: "format §2.1, §2.2",
    description: "Ill-typed document metadata and a FontEntry with only file and family: readers must not reject.",
    build: () =>
      deck({
        slides: [svg(box(A))],
        project: { author: 42, created: "yesterday", cover: "slides/999.svg", lang: "not a tag!", fonts: [{ file: "fonts/A.ttf", family: "A" }] },
        files: { "fonts/A.ttf": "font" },
        validate: false,
      }),
    expect: { open: "accept", slides: [{ status: "ok" }] },
  },
  {
    id: "slide-not-well-formed",
    rule: "playback §4",
    description: "A slide that is not well-formed XML shows as an error slide, the deck still opens.",
    build: () => deck({ slides: [`<svg xmlns="http://www.w3.org/2000/svg"><g></svg>`, svg(box(A))] }),
    expect: { open: "accept", slides: [{ status: "corrupt" }, { status: "ok" }] },
  },

  // ── Effects and steps ───────────────────────────────────────────────
  {
    id: "effects-steps-and-prehide",
    rule: "format §6.3, playback §2",
    description: "on-click opens steps; only targets whose first effect is enter start hidden.",
    build: () =>
      slideWith(
        effects(
          fx({ target: A, family: "enter", effect: "fade", start: "on-click" }),
          fx({ target: B, family: "emphasis", effect: "pulse", start: "with-previous" }),
          fx({ target: B, family: "enter", effect: "zoom", start: "on-click" }),
          fx({ target: C, family: "exit", effect: "fade-out", start: "after-previous" }),
        ),
      ),
    expect: { open: "accept", slides: [{ status: "ok", steps: 2, hidden: [A] }] },
  },
  {
    id: "effects-all-options",
    rule: "format §6.1, §6.2",
    description: "Every optional effect attribute in a valid combination, and the new fly directions.",
    build: () =>
      slideWith(
        effects(
          fx({ target: A, family: "enter", effect: "fly-down", start: "on-click", easing: "overshoot", by: "word", stagger: "0.05" }),
          fx({ target: B, family: "emphasis", effect: "spin", start: "after-previous", repeat: "2", easing: "linear", duration: "0.4", delay: ".1" }),
          fx({ target: C, family: "exit", effect: "fly-out-left", start: "on-click", by: "letter" }),
          fx({ target: A, family: "path", effect: "path", start: "on-click", d: "M0 0 L100 0", easing: "ease-in-out" }),
        ),
      ),
    expect: { open: "accept", slides: [{ status: "ok", steps: 3, hidden: [A] }] },
  },
  {
    id: "effects-triggers",
    rule: "format §6.3, playback §3.6",
    description: "Triggered effects leave the slide's steps and form their trigger's own; a triggered entrance starts hidden.",
    build: () =>
      slideWith(
        effects(
          fx({ target: B, family: "enter", effect: "fade", start: "on-click", trigger: A }),
          fx({ target: C, family: "enter", effect: "fade", start: "on-click" }),
          fx({ target: B, family: "emphasis", effect: "pulse", start: "on-click", trigger: A }),
        ),
      ),
    expect: { open: "accept", slides: [{ status: "ok", steps: 1, hidden: [B, C], triggers: { [A]: 2 } }] },
  },
  corruptEffect("effects-missing-attribute", "format §6.4", "An effect with no start.", [fx({ target: A, family: "enter", effect: "fade" })]),
  corruptEffect("effects-unknown-family", "format §6.4", 'family="wobble".', [fx({ target: A, family: "wobble", effect: "fade", start: "on-click" })]),
  corruptEffect("effects-unknown-effect", "format §6.4", "An enter effect named spin.", [fx({ target: A, family: "enter", effect: "spin", start: "on-click" })]),
  corruptEffect("effects-unknown-start", "format §6.4", 'start="later".', [fx({ target: A, family: "enter", effect: "fade", start: "later" })]),
  corruptEffect("effects-target-missing", "format §6.4", "A target no element on the slide has.", [fx({ target: "el-NOSUCHTARGET", family: "enter", effect: "fade", start: "on-click" })]),
  corruptEffect("effects-path-without-d", "format §6.4", "A path effect with no d.", [fx({ target: A, family: "path", effect: "path", start: "on-click" })]),
  corruptEffect("effects-empty-duration", "format §6.4", 'duration="" is invalid, not the default.', [fx({ target: A, family: "enter", effect: "fade", start: "on-click", duration: "" })]),
  corruptEffect("effects-hex-duration", "format §6.1, §6.4", 'duration="0x10" is not a plain decimal.', [fx({ target: A, family: "enter", effect: "fade", start: "on-click", duration: "0x10" })]),
  corruptEffect("effects-negative-delay", "format §6.4", 'delay="-1".', [fx({ target: A, family: "enter", effect: "fade", start: "on-click", delay: "-1" })]),
  corruptEffect("effects-first-not-on-click", "format §6.4", "The first effect starts with-previous.", [fx({ target: A, family: "enter", effect: "fade", start: "with-previous" })]),
  corruptEffect("effects-trigger-first-not-on-click", "format §6.4", "A trigger's own first effect starts after-previous.", [
    fx({ target: B, family: "enter", effect: "fade", start: "after-previous", trigger: A }),
  ]),
  corruptEffect("effects-media-without-source", "format §6.4", "A media play effect whose target has no data-slidra-media.", [fx({ target: A, family: "media", effect: "play", start: "on-click" })]),
  corruptEffect("effects-media-unsupported", "format §4.5, §6.4", "A media play effect on a .gif.", [fx({ target: "el-MEDIAMEDIA01", family: "media", effect: "play", start: "on-click" })], {
    body: '<g id="el-MEDIAMEDIA01" data-slidra-media="../assets/clip.gif"><rect width="10" height="10"/></g>',
  }),
  corruptEffect("effects-bad-easing", "format §6.4", 'easing="bouncy".', [fx({ target: A, family: "enter", effect: "fade", start: "on-click", easing: "bouncy" })]),
  corruptEffect("effects-easing-on-media", "format §6.4", "easing on a media effect.", [fx({ target: "el-MEDIAMEDIA01", family: "media", effect: "play", start: "on-click", easing: "linear" })], {
    body: '<g id="el-MEDIAMEDIA01" data-slidra-media="../assets/clip.webm"><rect width="10" height="10"/></g>',
  }),
  corruptEffect("effects-repeat-on-enter", "format §6.4", "repeat on an enter effect.", [fx({ target: A, family: "enter", effect: "fade", start: "on-click", repeat: "2" })]),
  corruptEffect("effects-repeat-zero", "format §6.4", 'repeat="0".', [fx({ target: A, family: "emphasis", effect: "pulse", start: "on-click", repeat: "0" })]),
  corruptEffect("effects-by-on-emphasis", "format §6.4", "by on an emphasis effect.", [fx({ target: A, family: "emphasis", effect: "pulse", start: "on-click", by: "word" })]),
  corruptEffect("effects-stagger-without-by", "format §6.4", "stagger with no by.", [fx({ target: A, family: "enter", effect: "fade", start: "on-click", stagger: "0.1" })]),
  corruptEffect("effects-trigger-missing", "format §6.4", "A trigger no element on the slide has.", [
    fx({ target: A, family: "enter", effect: "fade", start: "on-click", trigger: "el-NOSUCHTRIGGR" }),
  ]),

  // ── Transitions ─────────────────────────────────────────────────────
  {
    id: "transition-valid",
    rule: "format §7",
    description: "A valid transition, including a morph arrival.",
    build: () => deck({ slides: [svg(box(A), { metadata: `<slidra:transition xmlns:slidra="${NS}" enter="morph" enter-duration="0.8" exit="fade"/>` })] }),
    expect: { open: "accept", slides: [{ status: "ok", enter: "morph" }] },
  },
  {
    id: "transition-twice",
    rule: "format §7",
    description: "Two <slidra:transition> elements.",
    build: () => deck({ slides: [svg(box(A), { metadata: `<slidra:transition xmlns:slidra="${NS}" enter="fade"/><slidra:transition xmlns:slidra="${NS}" enter="zoom"/>` })] }),
    expect: { open: "accept", slides: [{ status: "corrupt", enter: "none" }] },
  },
  {
    id: "transition-unknown",
    rule: "format §7",
    description: 'enter="spiral".',
    build: () => deck({ slides: [svg(box(A), { metadata: `<slidra:transition xmlns:slidra="${NS}" enter="spiral"/>` })] }),
    expect: { open: "accept", slides: [{ status: "corrupt", enter: "none" }] },
  },
  {
    id: "transition-exit-morph",
    rule: "format §7",
    description: "morph is an arrival only.",
    build: () => deck({ slides: [svg(box(A), { metadata: `<slidra:transition xmlns:slidra="${NS}" exit="morph"/>` })] }),
    expect: { open: "accept", slides: [{ status: "corrupt", enter: "none" }] },
  },

  // ── Links, accessibility ────────────────────────────────────────────
  {
    id: "links",
    rule: "format §4.8",
    description: "Followable links are kept; javascript:, relative paths and unknown slide ids are ignored without making the slide corrupt.",
    build: () =>
      deck({
        slides: [
          svg(
            box("el-LINKWEB00001", ' data-slidra-link="https://example.com/"') +
              box("el-LINKSLIDE001", ' data-slidra-link="#s-SECONDSLIDE1"') +
              box("el-LINKNEXT0001", ' data-slidra-link="#next"') +
              box("el-LINKEVIL0001", ' data-slidra-link="javascript:alert(1)"') +
              box("el-LINKREL00001", ' data-slidra-link="slides/002.svg"') +
              box("el-LINKLOST0001", ' data-slidra-link="#s-NOSUCHSLIDE"'),
          ),
          svg(box(A), { attrs: ' data-slidra-slide-id="s-SECONDSLIDE1"' }),
        ],
      }),
    expect: {
      open: "accept",
      slides: [
        { status: "ok", links: ["el-LINKWEB00001", "el-LINKSLIDE001", "el-LINKNEXT0001"] },
        { status: "ok", links: [] },
      ],
    },
  },
  {
    id: "accessibility-title-and-language",
    rule: "format §4.7",
    description: "The root <title> names the slide; xml:lang on the slide overrides project.json lang.",
    build: () => deck({ project: { lang: "en" }, slides: [svg(`<title>Results</title>${box(A)}`), svg(box(A), { attrs: ' xml:lang="zh-Hant-TW"' })] }),
    expect: {
      open: "accept",
      slides: [
        { status: "ok", title: "Results", lang: "en" },
        { status: "ok", title: null, lang: "zh-Hant-TW" },
      ],
    },
  },
];

/** conformance/manifest.json: every case's file, rule, description and expected verdict. */
export function manifest() {
  return {
    formatVersion: 5,
    description: "Expected reader verdicts for the .slidra conformance decks. See conformance/README.md.",
    cases: CASES.map(({ id, rule, description, expect }) => ({ id, file: `decks/${id}.slidra`, rule, description, expect })),
  };
}
