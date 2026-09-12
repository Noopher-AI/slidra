#!/usr/bin/env node
// Fails when packages/server/agent-workdir/reference/commands.md (the
// agent-facing command summary) names a command or flag that
// docs/spec/cli.md (the regulatory CLI spec) does not cover — reference is
// supposed to be a strict subset of the spec. The
// opposite direction (a command in cli.md but not in reference) is not a
// violation: reference intentionally only summarizes a subset. Run
// manually or via `npm test`:
//
//   node scripts/check-reference-subset.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REFERENCE_PATH = path.join(ROOT, "packages/server/agent-workdir/reference/commands.md");
const SPEC_PATH = path.join(ROOT, "docs/spec/cli.md");

const FLAG_PATTERN = /--[a-z0-9-]+/g;

/** Splits `content` into `{ name, body }` sections at every match of `headingPattern` (must have exactly one capture group: the heading text). `body` runs from just after one heading to just before the next (or end of file). */
function splitSections(content, headingPattern) {
  const headings = [...content.matchAll(headingPattern)];
  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index + headings[i][0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
    sections.push({ name: headings[i][1].trim(), body: content.slice(start, end) });
  }
  return sections;
}

/**
 * Parses `reference/commands.md`: every `## <name>` heading is a command
 * (the file contains nothing else at H2). Flags are read only from that
 * command's `**參數**` (Parameters) line — the file's own format convention
 * — not from `**用途**` (Usage)/`**範例**` (Example)/free-text notes, so a
 * flag mentioned only in prose (e.g. a caveat about a flag that doesn't
 * exist) is never treated as a real parameter.
 */
export function extractReferenceCommands(content) {
  const commands = new Map();
  for (const { name, body } of splitSections(content, /^## (.+)$/gm)) {
    const flags = new Set();
    for (const line of body.split("\n")) {
      if (line.startsWith("**參數**")) {
        for (const match of line.matchAll(FLAG_PATTERN)) flags.add(match[0]);
      }
    }
    commands.set(name, flags);
  }
  return commands;
}

/**
 * Parses `docs/spec/cli.md`: only a heading of the exact form `` ## `name` ``
 * (backticks, nothing else on the line) is a command entry — every other H2
 * in the file (the 通則 (general rules) sections, appendices) deliberately
 * does not start with a backtick (see the file's own "命令條目格式說明"
 * (command entry format) section), so this pattern alone is enough to
 * separate the two. Flags are read from the command's ENTIRE section
 * (語法/參數/成功 data/錯誤情境/範例 — syntax/parameters/success data/error
 * cases/example — all count), matching the spec's own rule: an entry's
 * whole section must contain the flag token.
 */
export function extractSpecCommands(content) {
  const commands = new Map();
  for (const { name, body } of splitSections(content, /^## `([^`]+)`$/gm)) {
    const flags = new Set();
    for (const match of body.matchAll(FLAG_PATTERN)) flags.add(match[0]);
    commands.set(name, flags);
  }
  return commands;
}

/**
 * Reference must be a subset of spec: every reference command must exist in
 * spec, and every flag reference mentions for that command must appear
 * somewhere in spec's own section for it. Flag comparison is a Set
 * membership check on whole tokens (`--csv` !== `--csv-asset`) — never
 * `section.includes(flag)`, which would let `--csv-asset` in spec silently
 * satisfy a reference requirement for bare `--csv`.
 */
export function findViolations(referenceCommands, specCommands) {
  const violations = [];
  for (const [name, flags] of referenceCommands) {
    const specFlags = specCommands.get(name);
    if (specFlags === undefined) {
      violations.push({ message: `reference/commands.md: 命令「${name}」不在 docs/spec/cli.md` });
      continue;
    }
    for (const flag of flags) {
      if (!specFlags.has(flag)) {
        violations.push({
          message: `reference/commands.md: 命令「${name}」的 ${flag} 不在 docs/spec/cli.md 的對應條目`,
        });
      }
    }
  }
  return violations;
}

function main() {
  // Deliberately not wrapped in try/catch: a missing docs/spec/cli.md (or a
  // missing reference file) must throw and fail `npm test` loudly, never
  // pass silently.
  const referenceContent = readFileSync(REFERENCE_PATH, "utf-8");
  const specContent = readFileSync(SPEC_PATH, "utf-8");

  const referenceCommands = extractReferenceCommands(referenceContent);
  const specCommands = extractSpecCommands(specContent);
  const violations = findViolations(referenceCommands, specCommands);

  const flagCount = [...referenceCommands.values()].reduce((sum, flags) => sum + flags.size, 0);

  if (violations.length === 0) {
    console.log(
      `Checked ${referenceCommands.size} commands, ${flagCount} flags — reference/commands.md is a subset of docs/spec/cli.md, no violations found.`,
    );
    return;
  }

  for (const violation of violations) {
    console.error(violation.message);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
