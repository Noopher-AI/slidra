#!/usr/bin/env node
// Fails when a Markdown doc or shell script tells someone to run an
// `npm run <x>` that doesn't exist in package.json's scripts — the exact
// bug pattern `npm run serve` used to be (see docs/verify-setup.md). Run
// manually or via `npm test`:
//
//   node scripts/check-doc-commands.mjs

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".fleet"]);
const SCANNED_EXTENSIONS = new Set([".md", ".sh"]);
const NPM_RUN_PATTERN = /npm run ([a-zA-Z0-9:_-]+)/g;

export function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

export function loadKnownScripts(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

export function findViolations(files, knownScripts, relativeTo) {
  const violations = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    content.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(NPM_RUN_PATTERN)) {
        const scriptName = match[1];
        if (!knownScripts.has(scriptName)) {
          violations.push({
            file: path.relative(relativeTo, file),
            line: index + 1,
            scriptName,
          });
        }
      }
    });
  }
  return violations;
}

function main() {
  const files = collectFiles(ROOT);
  const knownScripts = loadKnownScripts(ROOT);
  const violations = findViolations(files, knownScripts, ROOT);

  if (violations.length === 0) {
    console.log(`Checked ${files.length} files, no missing npm commands found.`);
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: npm run ${violation.scriptName} does not exist in package.json's scripts`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
