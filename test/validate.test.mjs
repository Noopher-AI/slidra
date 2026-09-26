import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateDeck } from "../lib/validate.js";
import { makeDeck, makeLegacyDeck, svg, zip } from "./fixtures/make-deck.mjs";

const manifest = JSON.parse(readFileSync(new URL("../conformance/manifest.json", import.meta.url), "utf8"));
const conformanceDeck = (file) => new Uint8Array(readFileSync(new URL(`../conformance/${file}`, import.meta.url)));
const codes = (report) => [...report.errors, ...report.warnings].map((issue) => issue.code);
const box = (id, extra = "") => `<g id="${id}"${extra}><rect width="10" height="10"/></g>`;

test("every deck the conformance suite says to reject is invalid", async () => {
  for (const item of manifest.cases.filter((c) => c.expect.open === "reject")) {
    const report = await validateDeck(conformanceDeck(item.file));
    assert.equal(report.valid, false, item.id);
    assert.deepEqual(
      report.errors.map((e) => e.code),
      ["deck-rejected"],
      item.id,
    );
  }
});

test("every corrupt slide in the conformance suite is an error", async () => {
  for (const item of manifest.cases.filter((c) => c.expect.open === "accept" && c.expect.slides.some((s) => s.status === "corrupt"))) {
    const report = await validateDeck(conformanceDeck(item.file));
    assert.equal(report.valid, false, item.id);
    assert.ok(codes(report).includes("slide-corrupt"), item.id);
  }
});

test("the example decks are valid", async () => {
  const names = readdirSync(new URL("../examples/", import.meta.url)).filter((file) => file.endsWith(".slidra"));
  assert.ok(names.length >= 4);
  for (const name of names) {
    const report = await validateDeck(new Uint8Array(readFileSync(new URL(`../examples/${name}`, import.meta.url))));
    assert.deepEqual(report.errors, [], name);
    // The sharing tour loads one image from the network on purpose, to show the consent notice.
    const allowed = (w) => w.code.startsWith("a11y-") || (name === "sharing.slidra" && w.code === "reference-external");
    assert.ok(report.warnings.every(allowed), `${name}: ${report.warnings.map((w) => w.code).join(", ")}`);
  }
  for (const name of ["motion.slidra", "sharing.slidra"]) {
    const report = await validateDeck(new Uint8Array(readFileSync(new URL(`../examples/${name}`, import.meta.url))));
    assert.ok(!report.warnings.some((w) => w.code.startsWith("a11y-")), `${name} names every image, chart and medium`);
  }
});

test("a clean deck has no findings at all", async () => {
  const report = await validateDeck(
    makeDeck({
      project: { lang: "en" },
      slides: [svg(`<g id="el-AAAAAAAAAAAA"><title>Logo</title><image href="../assets/logo.svg" width="10" height="10"/></g>`)],
      files: { "assets/logo.svg": "<svg/>" },
    }),
  );
  assert.deepEqual([...report.errors, ...report.warnings], []);
  assert.deepEqual(report.summary, { container: "sqlite", formatVersion: 6, slides: 1 });
});

test("reports slide-level rule breaks with their location", async () => {
  const deck = makeDeck({
    validate: false,
    project: { lang: "en", created: "yesterday", fonts: [{ file: "fonts/A.ttf", family: "A", license: "OFL", licenseFile: "fonts/OFL.txt", source: "x" }] },
    files: { "fonts/A.ttf": "font", "fonts/extra.ttf": "font" },
    slides: [
      svg(box("el-AAAAAAAAAAAA") + box("el-AAAAAAAAAAAA") + '<rect id="loose" width="5" height="5"/>' + box("el-background", ' data-slidra-role="background"'), {
        attrs: ' data-slidra-slide-id="s-DUPLICATEID1"',
      }),
      svg(`<g id="el-BBBBBBBBBBBB" data-slidra-link="javascript:alert(1)"><image href="../assets/missing.png"/><image href="https://example.com/x.png"/></g>`, {
        attrs: ' data-slidra-slide-id="s-DUPLICATEID1"',
        width: 800,
      }),
      svg(box("el-CCCCCCCCCCCC"), { attrs: ' data-slidra-slide-id="not-an-id"' }),
    ],
  });
  const report = await validateDeck(deck);
  const found = new Set(codes(report));
  for (const code of [
    "project-schema",
    "font-license-missing",
    "font-unregistered",
    "element-id-duplicate",
    "element-loose",
    "background-position",
    "background-lock",
    "slide-id-duplicate",
    "slide-viewbox",
    "link-ignored",
    "reference-missing",
    "reference-external",
    "a11y-unnamed",
    "slide-id-shape",
  ]) {
    assert.ok(found.has(code), `expected ${code} in ${[...found].join(", ")}`);
  }
  const duplicate = report.errors.find((e) => e.code === "element-id-duplicate");
  assert.deepEqual([duplicate.path, duplicate.element], ["slides/001.svg", "el-AAAAAAAAAAAA"]);
});

test("layout roles: core and prefixed values pass, anything else is role-unknown (format §4.9)", async () => {
  const roles = ["field", "node", "spine", "edge", "label", "garnish", "pro:timeline"];
  const good = await validateDeck(
    makeDeck({
      project: { lang: "en" },
      slides: [
        svg(
          box("el-background", ' data-slidra-lock="true" data-slidra-role="background"') + roles.map((role, i) => box(`el-ROLE${String(i).padStart(8, "0")}`, ` data-slidra-role="${role}"`)).join(""),
        ),
      ],
    }),
  );
  assert.deepEqual([...good.errors, ...good.warnings], []);

  const bad = await validateDeck(conformanceDeck("decks/roles-invalid.slidra"));
  assert.deepEqual(
    bad.errors.map((e) => [e.code, e.rule, e.element]),
    [
      ["role-unknown", "format §4.9", "el-AAAAAAAAAAAA"],
      ["role-unknown", "format §4.9", "el-BBBBBBBBBBBB"],
      ["role-unknown", "format §4.9", "el-CCCCCCCCCCCC"],
    ],
    "reported once each, not again as a schema problem",
  );
  assert.ok(!codes(bad).includes("slide-corrupt"), "an invalid role never makes the slide corrupt");
  for (const id of ["roles-core", "roles-extension"]) {
    const report = await validateDeck(conformanceDeck(`decks/${id}.slidra`));
    assert.deepEqual(report.errors, [], id);
  }
});

test("a legacy deck is a warning, not an error", async () => {
  const slides = [svg(box("el-AAAAAAAAAAAA"))];
  const five = await validateDeck(makeLegacyDeck({ project: { lang: "en" }, slides }));
  assert.equal(five.valid, true);
  assert.deepEqual(five.errors, []);
  assert.deepEqual(
    five.warnings.map((w) => [w.code, w.rule]),
    [["legacy-format-version", "format §1.2"]],
  );
  assert.match(five.warnings[0].message, /formatVersion 5.*writers produce formatVersion 6/);
  assert.equal(five.summary.formatVersion, 5);

  const project = JSON.stringify({ formatVersion: 4, name: "Z", lang: "en", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] });
  const four = await validateDeck(
    zip([
      ["project.json", project],
      ["slides/001.svg", slides[0]],
    ]),
  );
  assert.equal(four.summary.container, "zip");
  assert.ok(four.warnings.some((w) => w.code === "legacy-format-version"));
  assert.ok(!four.errors.some((e) => e.code === "legacy-format-version"));

  const current = await validateDeck(makeDeck({ project: { lang: "en" }, slides }));
  assert.ok(!codes(current).includes("legacy-format-version"));
});

test("a formatVersion this format does not define is an error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-v7-"));
  const file = path.join(dir, "seven.slidra");
  writeFileSync(file, makeDeck({ project: { lang: "en" }, slides: [svg(box("el-AAAAAAAAAAAA"))] }));
  const db = new DatabaseSync(file);
  const row = /** @type {{ data: Uint8Array }} */ (db.prepare("SELECT data FROM content WHERE path = 'project.json'").get());
  db.prepare("UPDATE content SET data = ? WHERE path = 'project.json'").run(Buffer.from(Buffer.from(row.data).toString("utf8").replace('"formatVersion": 6', '"formatVersion": 7'), "utf8"));
  db.exec("PRAGMA user_version = 7");
  db.close();
  const report = await validateDeck(new Uint8Array(readFileSync(file)));
  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ["deck-rejected"]);
});

test("a deck left in WAL mode is an error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slidra-wal-"));
  const file = path.join(dir, "wal.slidra");
  writeFileSync(file, makeDeck({ project: { lang: "en" }, slides: [svg(box("el-AAAAAAAAAAAA"))] }));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
  const report = await validateDeck(new Uint8Array(readFileSync(file)));
  assert.ok(codes(report).includes("container-wal"));
});

const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "slidra-validate.mjs");
const run = (args) => spawnSync(process.execPath, ["--no-warnings", cli, ...args], { encoding: "utf8" });

test("CLI: exit status, text and JSON output", () => {
  const good = path.join(new URL("../examples/minimal.slidra", import.meta.url).pathname);
  const bad = path.join(new URL("../conformance/decks/effects-hex-duration.slidra", import.meta.url).pathname);

  const ok = run([good]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^✓ .*minimal\.slidra \(sqlite, formatVersion 6, 10 slides\): 0 errors/m);

  const failing = run(["--json", good, bad]);
  assert.equal(failing.status, 1);
  const reports = JSON.parse(failing.stdout);
  assert.deepEqual(
    reports.map((r) => r.valid),
    [true, false],
  );
  assert.ok(reports[1].errors.some((e) => e.code === "slide-corrupt"));

  assert.equal(run(["--strict", good]).status, 1, "warnings fail under --strict");
  assert.doesNotMatch(run(["--quiet", good]).stdout, /^ {2}warning/m);
  assert.equal(run([]).status, 2);
  assert.equal(run(["--bogus", good]).status, 2);
  assert.match(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }), /Usage: slidra-validate/);
  assert.equal(run(["/no/such/file.slidra"]).status, 1);
});
