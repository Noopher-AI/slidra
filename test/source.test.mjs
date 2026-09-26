import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeDom } from "../lib/node-dom.js";
import { openDeck } from "../lib/viewer/deck.js";
import { fontFaceRules, playDocument, sourceExpressions } from "../lib/viewer/frame.js";
import { Player } from "../lib/viewer/player.js";
import { loadSlide, prepareSlide, useDom } from "../lib/viewer/slide.js";
import { BytesDeckSource, PlayableDeck, checkFileUrl, checkSourceProject, deckSourceFromBytes } from "../lib/viewer/source.js";
import { makeDeck, svg } from "./fixtures/make-deck.mjs";

useDom(nodeDom);

const FILES = "https://files.example.test";
const csp = (html) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];

/**
 * A deck source the way a server would serve one: project.json, one slide at
 * a time, and a URL (never bytes) for each packaged file. It records every
 * request so tests can say what the player asked for.
 * @param {{ slides: string[], fonts?: { file: string, family: string }[], files?: string[], ids?: boolean, presenter?: () => unknown }} options
 */
function lazySource({ slides, fonts = [], files = [], ids = true, presenter }) {
  const calls = { project: 0, slides: [], files: [], slideIds: 0 };
  const paths = slides.map((_, i) => `slides/${String(i + 1).padStart(3, "0")}.svg`);
  const source = {
    calls,
    async project() {
      calls.project++;
      return { formatVersion: 6, name: "Lazy deck", canvas: { width: 1280, height: 720 }, slides: paths, fonts };
    },
    async slide(path) {
      calls.slides.push(path);
      const index = paths.indexOf(path);
      if (index === -1) throw new Error(`no slide ${path}`);
      return slides[index];
    },
    fileUrl(path) {
      calls.files.push(path);
      return files.includes(path) ? `${FILES}/blobs/${encodeURIComponent(path)}?token=abc&v=1` : null;
    },
  };
  if (ids) {
    source.slideIds = async () => {
      calls.slideIds++;
      return slides.map((_, i) => `s-${String(i).padStart(12, "0")}`);
    };
  }
  if (presenter) source.presenter = presenter;
  return source;
}

const numbered = (count, body = (i) => `<g id="el-${String(i).padStart(12, "0")}"><text x="10" y="50">Slide ${i + 1}</text></g>`) =>
  Array.from({ length: count }, (_, i) => svg(body(i), { attrs: ` data-slidra-slide-id="s-${String(i).padStart(12, "0")}"` }));

test("deckSourceFromBytes serves a file's project, slides, files and slide ids", async () => {
  const bytes = makeDeck({ slides: numbered(2), files: { "assets/a.png": new Uint8Array([1, 2, 3]) } });
  const source = await deckSourceFromBytes(bytes, { fileName: "a.slidra" });
  const deck = await openDeck(bytes);
  assert.ok(source instanceof BytesDeckSource);
  assert.deepEqual(await source.project(), deck.project);
  assert.equal(await source.slide("slides/002.svg"), deck.readText("slides/002.svg"));
  assert.match(source.fileUrl("assets/a.png"), /^data:image\/png;base64,AQID$/);
  assert.equal(source.fileUrl("assets/missing.png"), null);
  assert.deepEqual(await source.slideIds(), ["s-000000000000", "s-000000000001"]);
  assert.equal(source.bytes, bytes, "kept for a presenter view");
  const playable = await PlayableDeck.open(source);
  assert.equal(playable.bytesDeck, source.deck);
  assert.equal(playable.fileName, "a.slidra");
});

test("a source's project.json is checked again: the player treats a source as untrusted", () => {
  const good = { formatVersion: 6, name: "x", canvas: { width: 1, height: 1 }, slides: ["slides/001.svg"] };
  assert.equal(checkSourceProject(good), good);
  for (const bad of [
    null,
    [],
    { ...good, formatVersion: 7 },
    { ...good, formatVersion: 0 },
    { ...good, formatVersion: "5" },
    { ...good, name: 3 },
    { ...good, canvas: { width: 0, height: 1 } },
    { ...good, slides: "slides/001.svg" },
    { ...good, slides: ["../escape.svg"] },
    { ...good, fonts: [{ file: "/etc/font.ttf", family: "x" }] },
  ]) {
    assert.throws(() => checkSourceProject(bad), /project\.json|formatVersion/, JSON.stringify(bad));
  }
});

test("file URLs: data:, blob: and http(s) only, made safe to sit in CSS and attributes", () => {
  assert.equal(checkFileUrl("https://cdn.example.test/f/a.woff2?sig=1&x=2"), "https://cdn.example.test/f/a.woff2?sig=1&x=2");
  assert.equal(checkFileUrl('https://cdn.example.test/a")b'), "https://cdn.example.test/a%22%29b");
  assert.equal(checkFileUrl("data:font/ttf;base64,AAAA"), "data:font/ttf;base64,AAAA");
  assert.match(checkFileUrl("blob:https://app.example.test/0b6d9a"), /^blob:/);
  for (const bad of ["javascript:alert(1)", "/relative/a.png", "a.png", "file:///etc/passwd", "", null, 3]) assert.equal(checkFileUrl(bad), null, String(bad));
});

test("the frame's CSP admits exactly the source's file URLs, never their whole origin", () => {
  assert.deepEqual(sourceExpressions([`${FILES}/blobs/a.png?token=1`, `${FILES}/blobs/a.png?token=2`, "data:image/png;base64,AA", "blob:https://x.test/1", "ftp://x.test/a", "nonsense"]), [
    `${FILES}/blobs/a.png`,
    "blob:",
  ]);
  assert.deepEqual(sourceExpressions(["https://x.test/a;b,c"]), ["https://x.test/a%3Bb%2Cc"], "; and , cannot start a new directive or policy");
  const policy = csp(playDocument("<svg/>", "", { steps: [], hidden: [], hideSelectors: {} }, -1, "", { files: [`${FILES}/blobs/f.woff2?t=1`] }));
  assert.match(
    policy,
    /img-src data: https:\/\/files\.example\.test\/blobs\/f\.woff2; media-src data: https:\/\/files\.example\.test\/blobs\/f\.woff2; font-src data: https:\/\/files\.example\.test\/blobs\/f\.woff2$/,
  );
  assert.doesNotMatch(policy, /https: /, "no scheme-wide network access");
  assert.doesNotMatch(policy, /sandbox|script-src 'unsafe/, "nothing else changes");
});

test("opening a source reads project.json and nothing else", async () => {
  const source = lazySource({ slides: numbered(30) });
  const deck = await PlayableDeck.open(source);
  assert.equal(deck.slides.length, 30);
  assert.equal(deck.name, "Lazy deck");
  assert.equal(deck.legacy, false);
  assert.deepEqual(source.calls, { project: 1, slides: [], files: [], slideIds: 0 });
  await assert.rejects(PlayableDeck.open(/** @type {any} */ ({ project: async () => ({}) })), /not a deck source/);
  await assert.rejects(
    PlayableDeck.open({
      project: async () => {
        throw new Error("HTTP 403");
      },
      slide: async () => "",
      fileUrl: () => null,
    }),
    /could not be read: HTTP 403/,
  );
});

test("a slide from a source references its files by URL, and they are not the deck's remote content", async () => {
  const slide = svg(
    [
      '<style>.bg{fill:url("../assets/pattern.svg")}</style>',
      '<g id="el-AAAAAAAAAAAA"><image href="../assets/photo.png" width="10" height="10"/></g>',
      '<g id="el-BBBBBBBBBBBB"><image href="../assets/missing.png"/><image href="https://tracker.example.test/pixel.png"/></g>',
      '<g id="el-CCCCCCCCCCCC" data-slidra-link="#s-000000000001"><rect width="5" height="5"/></g>',
    ].join(""),
  );
  const source = lazySource({ slides: [slide, ...numbered(1)], files: ["assets/photo.png", "assets/pattern.svg"] });
  const deck = await PlayableDeck.open(source);
  const prepared = await loadSlide(deck, 0);
  assert.deepEqual(source.calls.slides, ["slides/001.svg"], "one slide, only the one asked for");
  assert.deepEqual(source.calls.files.sort(), ["assets/missing.png", "assets/pattern.svg", "assets/photo.png"]);
  assert.match(prepared.markup, /href="https:\/\/files\.example\.test\/blobs\/assets%2Fphoto\.png\?token=abc&amp;v=1"/);
  assert.match(prepared.markup, /url\("https:\/\/files\.example\.test\/blobs\/assets%2Fpattern\.svg\?token=abc&amp;v=1"\)/);
  assert.match(prepared.markup, /href="\.\.\/assets\/missing\.png"/, "a file the source does not have stays as written");
  assert.doesNotMatch(prepared.markup, /data:/);
  assert.deepEqual(prepared.remote, ["https://tracker.example.test/pixel.png"], "only what the slide itself names from the network waits for consent");
  assert.equal(prepared.files.length, 2);
  assert.deepEqual(Object.keys(prepared.links), ["el-CCCCCCCCCCCC"], "a link to a slide resolves through slideIds()");
  assert.equal(source.calls.slideIds, 1);
  assert.equal(source.calls.slides.length, 1, "without reading any other slide");
});

test("a link to a slide from a source without slideIds() is kept and resolved when followed", async () => {
  const slides = numbered(3);
  slides[0] = svg('<g id="el-CCCCCCCCCCCC" data-slidra-link="#s-000000000002"><rect width="5" height="5"/></g>');
  const source = lazySource({ slides, ids: false });
  const deck = await PlayableDeck.open(source);
  const prepared = await loadSlide(deck, 0);
  assert.deepEqual(Object.keys(prepared.links), ["el-CCCCCCCCCCCC"]);
  assert.deepEqual(source.calls.slides, ["slides/001.svg"]);
  assert.equal(await deck.slideIndexById("s-000000000002"), 2);
  assert.equal(await deck.slideIndexById("s-nothere00000"), -1);
});

test("fonts load from the source's URL, not inlined", async () => {
  const source = lazySource({
    slides: numbered(1),
    fonts: [
      { file: "fonts/Brand.woff2", family: "Brand" },
      { file: "fonts/Gone.ttf", family: "Gone" },
    ],
    files: ["fonts/Brand.woff2"],
  });
  const deck = await PlayableDeck.open(source);
  const fonts = await deck.fonts();
  assert.deepEqual(fonts, [{ family: "Brand", file: "fonts/Brand.woff2", url: `${FILES}/blobs/fonts%2FBrand.woff2?token=abc&v=1` }]);
  assert.equal(fontFaceRules(fonts), `@font-face{font-family:"Brand";src:url("${FILES}/blobs/fonts%2FBrand.woff2?token=abc&v=1") format("woff2");font-display:block}`);
});

test("a deck in memory prepares exactly as before through its source", async () => {
  const bytes = makeDeck({ slides: [svg('<g id="el-AAAAAAAAAAAA"><image href="../assets/a.png"/></g>')], files: { "assets/a.png": new Uint8Array([1]) } });
  const deck = await openDeck(bytes);
  const before = prepareSlide(deck, 0);
  assert.match(before.markup, /href="data:image\/png;base64,AQ=="/);
  assert.deepEqual(before.files, ["data:image/png;base64,AQ=="]);
  const viaSource = await loadSlide(await PlayableDeck.open(await deckSourceFromBytes(bytes)), 0);
  assert.equal(viaSource.markup, before.markup);
});

/** Just enough of a browser for the Player: a frame whose runtime answers "ready" as soon as a document is loaded. */
function fakePlayer() {
  const listeners = [];
  globalThis.window = /** @type {any} */ ({
    addEventListener: (type, fn) => listeners.push(fn),
    removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    open() {},
  });
  const documents = [];
  const contentWindow = { postMessage() {} };
  const frame = {
    dataset: {},
    title: "",
    contentWindow,
    focus() {},
    get srcdoc() {
      return documents.at(-1) ?? "";
    },
    set srcdoc(html) {
      documents.push(html);
      const ready = { source: contentWindow, data: { source: "slidra-player", event: "ready", step: -1 } };
      if (html) queueMicrotask(() => listeners.forEach((listener) => listener(ready)));
    },
  };
  const surface = { style: { removeProperty() {} } };
  const player = new Player({ frame: /** @type {any} */ (frame), surface: /** @type {any} */ (surface), embedLayer: /** @type {any} */ ({}), runtimeSource: "/*runtime*/" });
  return { player, documents };
}

test("the player reads only the slides around the one it shows, and loads fonts by URL", async () => {
  const source = lazySource({ slides: numbered(40), fonts: [{ file: "fonts/Brand.woff2", family: "Brand" }], files: ["fonts/Brand.woff2"] });
  const { player, documents } = fakePlayer();
  const errors = [];
  player.addEventListener("slideerror", (event) => errors.push(/** @type {CustomEvent} */ (event).detail.message));
  try {
    player.load(await PlayableDeck.open(source));
    await player.show(19);
    await player.next();
    await player.previous();
    await new Promise((resolve) => setTimeout(resolve, 300)); // the idle preload of the next slide
    assert.deepEqual(errors, []);
    assert.equal(player.index, 19);
    const asked = [...new Set(source.calls.slides)].sort();
    assert.deepEqual(asked, ["slides/020.svg", "slides/021.svg", "slides/022.svg"], "the shown slides and the next one, nothing else");
    assert.equal(source.calls.project, 1);

    const html = documents.at(-1);
    const fontUrl = `${FILES}/blobs/fonts%2FBrand.woff2?token=abc&v=1`;
    assert.ok(html.includes(`src:url("${fontUrl}")`), "the @font-face points at the source's URL");
    assert.doesNotMatch(html, /data:font|base64/, "nothing inlined");
    assert.match(csp(html), new RegExp(`font-src data: ${FILES.replace(/\./g, "\\.")}/blobs/fonts%2FBrand\\.woff2$`));
  } finally {
    player.destroy();
    delete globalThis.window;
  }
});

test("a slide the source cannot serve is an error on that slide, and asking again asks the source again", async () => {
  const source = lazySource({ slides: numbered(3) });
  const failing = { ...source, slide: async (path) => (path === "slides/002.svg" ? Promise.reject(new Error("HTTP 500")) : source.slide(path)) };
  const { player } = fakePlayer();
  const errors = [];
  player.addEventListener("slideerror", (event) => errors.push(/** @type {CustomEvent} */ (event).detail.message));
  try {
    player.load(await PlayableDeck.open(failing));
    await player.show(1);
    assert.deepEqual(errors, ["Slide 2 could not be read: HTTP 500"]);
    assert.equal(player.prepared.has(1), false, "the failure is not kept");
  } finally {
    player.destroy();
    delete globalThis.window;
  }
});

test("a source can hand a presenter view a descriptor instead of bytes", async () => {
  const deck = await PlayableDeck.open(lazySource({ slides: numbered(1), presenter: () => ({ deckId: "d-1" }) }));
  assert.deepEqual(deck.presenterDescriptor(), { deckId: "d-1" });
  assert.equal((await PlayableDeck.open(lazySource({ slides: numbered(1) }))).presenterDescriptor(), undefined);
});
