import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SPEC_PATH = path.join(REPO_ROOT, "docs/spec/cli.md");

/**
 * The one place `docs/spec/cli.md`'s command entries are parsed out of the
 * document — a command entry heading is exactly `` ## `<name>` `` (backticks,
 * nothing else on the line); every other H2 in the file (通則 sections,
 * appendices) deliberately does not start with a backtick, per the spec's
 * own "命令條目格式說明" section, so this single pattern is enough to tell
 * the two apart.
 */
function extractSpecEntries(specContent: string): Map<string, string> {
  const headingPattern = /^## `([^`]+)`$/gm;
  const headings = [...specContent.matchAll(headingPattern)];
  const entries = new Map<string, string>();
  for (let i = 0; i < headings.length; i++) {
    const name = headings[i][1].trim();
    const start = headings[i].index! + headings[i][0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index! : specContent.length;
    entries.set(name, specContent.slice(start, end));
  }
  return entries;
}

describe("docs/spec/cli.md command coverage", () => {
  const specContent = readFileSync(SPEC_PATH, "utf-8");
  const specEntries = extractSpecEntries(specContent);
  const registryNames = createDefaultRegistry().names();

  it("has exactly 81 command entries, matching CommandRegistry.names() in both directions", () => {
    expect(registryNames.length).toBe(81);
    expect(specEntries.size).toBe(81);

    const registrySet = new Set(registryNames);
    const specSet = new Set(specEntries.keys());

    const inRegistryNotInSpec = registryNames.filter((name) => !specSet.has(name));
    const inSpecNotInRegistry = [...specEntries.keys()].filter((name) => !registrySet.has(name));

    expect(inRegistryNotInSpec).toEqual([]);
    expect(inSpecNotInRegistry).toEqual([]);
  });

  it("never uses the backtick-H2 command-entry title format for a non-command section (serve/export/通則/附錄)", () => {
    // A H2 that starts with a backtick but is not a real command would
    // silently inflate the count above 81 without either of the two set
    // diffs catching it (a name only this test would ever see). Assert the
    // total entry count against a second, independent extraction pass that
    // doesn't rely on set membership at all.
    const allBacktickHeadings = [...specContent.matchAll(/^## `([^`]+)`$/gm)];
    expect(allBacktickHeadings.length).toBe(81);
  });

  for (const name of ["new", "cat", "effect list", "table cell paste", "comment list"]) {
    it(`registers "${name}" (spot check)`, () => {
      expect(registryNames).toContain(name);
      expect(specEntries.has(name)).toBe(true);
    });
  }

  it("gives every command entry all five required subsections in order", () => {
    const requiredMarkers = ["**語法**", "**參數**", "**成功 `data`**", "**錯誤情境**", "**範例**"];
    const missing: string[] = [];

    for (const [name, body] of specEntries) {
      for (const marker of requiredMarkers) {
        if (!body.includes(marker)) {
          missing.push(`${name}: missing ${marker}`);
        }
      }
      // Order matters (spec's own contract, section "命令條目格式說明"):
      // 語法 → 參數 → 成功 data → 錯誤情境 → 範例.
      const positions = requiredMarkers.map((marker) => body.indexOf(marker));
      const sorted = [...positions].sort((a, b) => a - b);
      if (JSON.stringify(positions) !== JSON.stringify(sorted)) {
        missing.push(`${name}: subsections out of order`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("gives every command entry at least one row in its 錯誤情境 table", () => {
    const missing: string[] = [];
    for (const [name, body] of specEntries) {
      const errorSectionStart = body.indexOf("**錯誤情境**");
      const exampleSectionStart = body.indexOf("**範例**");
      const errorSection = body.slice(errorSectionStart, exampleSectionStart);
      // A markdown table body row looks like "| ... | `not-found` |" or
      // "| ... | `failed` |" — at least one such row must exist.
      if (!/\|\s*`(not-found|failed)`\s*\|/.test(errorSection)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has the three known-gap definitions (asset import / chart data set / effect list) in their entries", () => {
    expect(specEntries.get("asset import")).toContain("--as");
    expect(specEntries.get("chart data set")).toContain("--csv -");
    expect(specEntries.get("effect list")).toContain('"steps"');
    expect(specEntries.get("effect list")).toContain('"transition"');
  });
});
