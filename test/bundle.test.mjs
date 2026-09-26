import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildBundle, listFiles } from "../tools/build-bundle.mjs";
import { ROOT } from "../tools/element-options.mjs";
import { validateDeck } from "../lib/validate.js";

// What player/slidra-viewer.js exports (lib/viewer/index.js), as the READMEs document it.
const VIEWER_EXPORTS = [
  "APPLICATION_ID",
  "BytesDeckSource",
  "DEFAULT_LIMITS",
  "Deck",
  "DeckError",
  "FORMAT_VERSION",
  "NAMESPACE",
  "PER_PAGE",
  "PLAYER_RUNTIME",
  "PlayableDeck",
  "Player",
  "buildPrintout",
  "deckInfo",
  "deckSourceFromBytes",
  "fontFaceCss",
  "markupAtStep",
  "openDeck",
  "openSource",
  "prepareSlide",
  "printEntries",
  "renderSlidePng",
  "renderThumbnail",
  "startPresenter",
  "startViewer",
  "staticDocument",
  "zipStore",
];

const temp = () => mkdtempSync(path.join(tmpdir(), "slidra-bundle-"));
const first = temp();
const second = temp();
const built = Promise.all([buildBundle(first), buildBundle(second)]);
process.on("exit", () => {
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});

test("two builds of the bundle are byte-identical", async () => {
  await built;
  const files = listFiles(first);
  assert.deepEqual(listFiles(second), files);
  for (const file of files) assert.ok(readFileSync(path.join(first, file)).equals(readFileSync(path.join(second, file))), `${file} differs between builds`);
});

test("MANIFEST.json lists every other file with its size and sha256, sorted by path", async () => {
  await built;
  const manifest = JSON.parse(readFileSync(path.join(first, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.formatVersion, 6);
  assert.match(manifest.source.commit ?? "", /^[0-9a-f]{40}$|^$/);
  const listed = manifest.files.map((file) => file.path);
  assert.deepEqual(listed, [...listed].sort());
  assert.deepEqual(
    listed,
    listFiles(first).filter((file) => file !== "MANIFEST.json"),
  );
  for (const { path: file, size, sha256 } of manifest.files) {
    const bytes = readFileSync(path.join(first, file));
    assert.equal(bytes.length, size, file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
  }
  for (const file of [
    "LICENSE",
    "player/player-runtime.js",
    "player/slidra-player.js",
    "player/slidra-viewer.js",
    "validator/slidra-validate.mjs",
    "spec/slidra-format.md",
    "spec/playback.md",
    "conformance/manifest.json",
    "conformance/README.md",
  ]) {
    assert.ok(listed.includes(file), `${file} is in the bundle`);
  }
  assert.deepEqual(
    listed.filter((file) => file.startsWith("schema/")).map((file) => file.slice("schema/".length)),
    readdirSync(path.join(ROOT, "spec/schema")).sort(),
  );
  const cases = JSON.parse(readFileSync(path.join(ROOT, "conformance/manifest.json"), "utf8")).cases;
  for (const { file } of cases) assert.ok(listed.includes(`conformance/${file}`), `conformance/${file} is in the bundle`);
  assert.equal(readFileSync(path.join(first, "player/player-runtime.js"), "utf8"), readFileSync(path.join(ROOT, "public/js/player-runtime.js"), "utf8"));
});

test("nothing in the bundle names the directory it was built in", async () => {
  await built;
  for (const file of listFiles(first)) {
    const text = readFileSync(path.join(first, file)).toString("latin1");
    assert.ok(!text.includes(ROOT), `${file} contains ${ROOT}`);
    assert.ok(!text.includes(first), `${file} contains ${first}`);
  }
});

test("the bundled validator is self-contained and agrees with lib/validate.js", async () => {
  await built;
  const source = readFileSync(path.join(first, "validator/slidra-validate.mjs"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s[^;]*from\s*"(?!node:)/m, "only node: built-ins are imported");
  const bundled = await import(pathToFileURL(path.join(first, "validator/slidra-validate.mjs")).href);
  assert.deepEqual(Object.keys(bundled).sort(), ["runValidateCli", "validateDeck"]);
  const decks = [
    ...readdirSync(path.join(ROOT, "examples"))
      .filter((name) => name.endsWith(".slidra"))
      .map((name) => path.join(ROOT, "examples", name)),
    ...listFiles(path.join(ROOT, "conformance/decks")).map((name) => path.join(ROOT, "conformance/decks", name)),
  ];
  assert.ok(decks.length > 10);
  for (const deck of decks) {
    const bytes = new Uint8Array(readFileSync(deck));
    const options = { fileName: path.basename(deck) };
    assert.deepEqual(await bundled.validateDeck(bytes, options), await validateDeck(bytes, options), path.relative(ROOT, deck));
  }
});

test("the bundled viewer exports exactly the documented API, with the slide runtime inlined", async () => {
  await built;
  const source = readFileSync(path.join(first, "player/slidra-viewer.js"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "no imports left: everything is bundled");
  assert.doesNotMatch(source, /__SLIDRA_RUNTIME__/);
  const bundled = await import(pathToFileURL(path.join(first, "player/slidra-viewer.js")).href);
  assert.deepEqual(Object.keys(bundled).sort(), VIEWER_EXPORTS);
  assert.deepEqual(Object.keys(await import("../lib/viewer/index.js")).sort(), VIEWER_EXPORTS);
  assert.equal(bundled.PLAYER_RUNTIME, readFileSync(path.join(ROOT, "public/js/player-runtime.js"), "utf8"));
  assert.equal(bundled.FORMAT_VERSION, 6);
  for (const name of ["startViewer", "startPresenter", "deckSourceFromBytes", "openDeck", "buildPrintout"]) assert.equal(typeof bundled[name], "function", name);
});

test("the viewer's and presenter view's markup carry the ids their scripts wire onto", async () => {
  await built;
  const viewer = readFileSync(path.join(first, "player/viewer-shell.html"), "utf8");
  for (const id of ["home", "viewer", "stage", "slide-frame", "overview-grid", "print-dialog", "notes-panel"]) assert.match(viewer, new RegExp(`id="${id}"`), id);
  const presenter = readFileSync(path.join(first, "player/presenter-shell.html"), "utf8");
  for (const id of ["presenter", "p-frame", "p-notes", "p-next-image"]) assert.match(presenter, new RegExp(`id="${id}"`), id);
});
