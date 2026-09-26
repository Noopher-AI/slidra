import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DEFAULT_LIMITS } from "../lib/viewer/deck.js";

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const pkg = JSON.parse(read("package.json"));

test("the community files exist", () => {
  for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "LICENSE", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/config.yml"]) {
    assert.ok(existsSync(new URL(file, root)), file);
  }
});

test("CONTRIBUTING lists exactly the npm scripts package.json has", () => {
  const contributing = read("CONTRIBUTING.md");
  const documented = new Set([...contributing.matchAll(/`npm (?:run )?([a-z0-9:-]+)/g)].map((m) => m[1]).filter((name) => !["install"].includes(name)));
  const scripts = new Set(Object.keys(pkg.scripts));
  for (const script of scripts) assert.ok(documented.has(script), `CONTRIBUTING.md does not mention npm run ${script}`);
  for (const name of documented) assert.ok(scripts.has(name), `CONTRIBUTING.md mentions npm run ${name}, which package.json does not define`);
});

test("SECURITY states the readers' real limits", () => {
  const security = read("SECURITY.md");
  const mb = (bytes) => bytes / 1024 / 1024;
  assert.match(security, new RegExp(`${mb(DEFAULT_LIMITS.maxDeckBytes) / 1024} GB per deck`));
  assert.match(security, new RegExp(`${mb(DEFAULT_LIMITS.maxEntryBytes)} MB per entry`));
  assert.match(security, new RegExp(`${DEFAULT_LIMITS.maxEntries.toLocaleString("en-US")} entries`));
});

test("issue templates carry a name and a description, and security goes elsewhere", () => {
  const dir = new URL(".github/ISSUE_TEMPLATE/", root);
  const templates = readdirSync(dir).filter((file) => file.endsWith(".md"));
  assert.ok(templates.length >= 3);
  for (const file of templates) {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(new URL(file, dir), "utf8"));
    assert.ok(front, `${file} has front matter`);
    assert.match(front[1], /^name: .+$/m, file);
    assert.match(front[1], /^about: .+$/m, file);
  }
  const config = readFileSync(new URL("config.yml", dir), "utf8");
  assert.match(config, /blank_issues_enabled: false/);
  assert.match(config, /security\/advisories\/new/);
});

test("the changelog has an Unreleased section and the current version", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /^## Unreleased$/m);
  assert.match(changelog, new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")}$`, "m"));
});

test("both READMEs point to the community files", () => {
  for (const readme of ["README.md", "README.zh-TW.md"]) {
    const text = read(readme);
    for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) assert.ok(text.includes(`(${file})`), `${readme} links ${file}`);
  }
});
