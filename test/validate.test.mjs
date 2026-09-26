import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateDeck } from "../lib/validate.js";
import { makeDeck, svg } from "./fixtures/make-deck.mjs";

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
  for (const name of ["showcase.slidra", "minimal.slidra"]) {
    const report = await validateDeck(new Uint8Array(readFileSync(new URL(`../examples/${name}`, import.meta.url))));
    assert.deepEqual(report.errors, [], name);
    assert.ok(
      report.warnings.every((w) => w.code.startsWith("a11y-")),
      name,
    );
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
  assert.deepEqual(report.summary, { container: "sqlite", formatVersion: 5, slides: 1 });
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
  assert.match(ok.stdout, /^✓ .*minimal\.slidra \(sqlite, formatVersion 5, 10 slides\): 0 errors/m);

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
