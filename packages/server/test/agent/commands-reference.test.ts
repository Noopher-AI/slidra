// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEditorialBrief } from "../../src/agent/brief.js";
import { resolveAgentWorkdirSource } from "../../src/agent/workdir.js";

// `reference/commands.md` is hand-written, not generated — there is no
// in-process command registry left in `packages/server` at all to compare
// it against. What keeps it honest now is a bidirectional set comparison
// between `docs/spec/cli.md`'s own `` ## `name` `` section headings (the
// Rust binary's authoritative command list) and this document's
// `## <name>` section headings: either side having something the other
// lacks is a failure, which is what a generated document's
// staleness-detection would have given for free. `docs/spec/cli.md` has 81
// such headings, matching `reference/commands.md`'s own 81 (verified
// separately).

const commandsReferencePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-workdir/reference/commands.md",
);
const cliSpecPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/spec/cli.md");

async function readCommandsReference(): Promise<string> {
  return readFile(commandsReferencePath, "utf8");
}

/** `docs/spec/cli.md`'s own command names — every `` ## `name` `` heading, the same pattern `scripts/check-reference-subset.mjs` uses. */
async function readCliSpecCommandNames(): Promise<string[]> {
  const content = await readFile(cliSpecPath, "utf8");
  return [...content.matchAll(/^## `([^`]+)`$/gm)].map((match) => match[1]);
}

// Read once, at module load — every describe block below compares against
// this same list, the same way they used to share one `createDefaultRegistry()`.
const specCommandNames = await readCliSpecCommandNames();

/** Every `## <name>` heading, in document order — the document's own claimed command list. */
function extractHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
}

/**
 * The two-way diff `commands-reference.test.ts` is built around: names only
 * `docs/spec/cli.md` has (undocumented here) and names only this document
 * has (stale — renamed or removed from the spec, but a section was left
 * behind). A command name is never a prefix of another (verified
 * separately), so an exact-string comparison is enough — no markdown
 * parsing of heading structure beyond the heading line itself is needed.
 *
 * This same function also proves its own bidirectionality
 * (formerly a separate "A15" test asserting a mock registry's undocumented/
 * stale names) — the real `docs/spec/cli.md` vs. `reference/commands.md`
 * comparison below exercises both directions on 81 real names each, a
 * strictly stronger proof of the same logic than a single hand-built pair
 * ever was.
 */
function diffCommandNames(specNames: string[], documentHeadings: string[]): { undocumented: string[]; stale: string[] } {
  const specSet = new Set(specNames);
  const documentSet = new Set(documentHeadings);
  return {
    undocumented: specNames.filter((name) => !documentSet.has(name)),
    stale: documentHeadings.filter((name) => !specSet.has(name)),
  };
}

describe("reference/commands.md covers every slidra binary command", () => {
  it("has exactly one H2 section per docs/spec/cli.md command name, both directions", async () => {
    const headings = extractHeadings(await readCommandsReference());
    expect(diffCommandNames(specCommandNames, headings)).toEqual({ undocumented: [], stale: [] });
  });
});

describe("reference/commands.md section structure", () => {
  it("gives every command section a Parameters / Purpose / Example field, not just a bare heading", async () => {
    const markdown = await readCommandsReference();
    const headings = extractHeadings(markdown);
    expect(headings.length).toBeGreaterThan(0);
    const sections = markdown.split(/^## /m).slice(1);
    expect(sections).toHaveLength(headings.length);
    for (const section of sections) {
      const name = section.split("\n", 1)[0].trim();
      expect(section, `${name} missing **Parameters**`).toMatch(/\*\*Parameters\*\*/);
      expect(section, `${name} missing **Usage**`).toMatch(/\*\*Usage\*\*/);
      expect(section, `${name} missing **Example**`).toMatch(/\*\*Example\*\*/);
    }
  });

  it("never uses an H2 for a command's sub-field — H2 is reserved for command names", async () => {
    const markdown = await readCommandsReference();
    const specNames = new Set(specCommandNames);
    for (const heading of extractHeadings(markdown)) {
      expect(specNames.has(heading)).toBe(true);
    }
  });
});

describe("editorial brief and reference/commands.md stay consistent", () => {
  const presentationId = "test-presentation-id";
  const brief = buildEditorialBrief(presentationId);

  /** `docs/spec/cli.md` command names that appear in `text` as whole words (word-boundary match, so the short command `ls` does not match "list"/"tools"/etc. in prose). */
  function commandsMentionedIn(text: string): string[] {
    return specCommandNames.filter((name) =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text),
    );
  }

  it("names only commands that actually exist in docs/spec/cli.md", () => {
    const mentioned = commandsMentionedIn(brief);
    const specNames = new Set(specCommandNames);
    for (const name of mentioned) {
      expect(specNames.has(name)).toBe(true);
    }
  });

  it("names only commands that also have a reference/commands.md section", async () => {
    const headings = new Set(extractHeadings(await readCommandsReference()));
    for (const name of commandsMentionedIn(brief)) {
      expect(headings.has(name), `${name} mentioned in the editing rules but has no section in reference/commands.md`).toBe(true);
    }
  });

  it("has been slimmed to name only `chat-history`, `text set`, and `comment list`", () => {
    expect(commandsMentionedIn(brief).sort()).toEqual(["chat-history", "comment list", "text set"]);
    expect(brief).toContain("reference/commands.md");
  });

  // Same guarantee as above, extended to the work directory's own
  // documentation — AGENTS.md and the shipped SKILL.md files reference
  // `slidra` commands too, and those mentions must stay real (in
  // docs/spec/cli.md) and documented (in this same file).
  it("AGENTS.md and every shipped SKILL.md name only commands that exist in docs/spec/cli.md and are documented", async () => {
    const specNames = new Set(specCommandNames);
    const headings = new Set(extractHeadings(await readCommandsReference()));
    const workdirSource = resolveAgentWorkdirSource();
    const agentsMd = await readFile(path.join(workdirSource, "AGENTS.md"), "utf8");
    const skillDirs = await readdir(path.join(workdirSource, ".agents", "skills"), { withFileTypes: true });
    const skillTexts = await Promise.all(
      skillDirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => readFile(path.join(workdirSource, ".agents", "skills", entry.name, "SKILL.md"), "utf8")),
    );

    for (const text of [agentsMd, ...skillTexts]) {
      for (const name of commandsMentionedIn(text)) {
        expect(specNames.has(name)).toBe(true);
        expect(headings.has(name), `${name} mentioned in the workdir docs but has no section in reference/commands.md`).toBe(true);
      }
    }
  });
});
