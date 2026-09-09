import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEditorialBrief } from "../../src/agent/brief.js";
import { resolveAgentWorkdirSource } from "../../src/agent/workdir.js";

// NOOP-238: `reference/commands.md` is hand-written, not generated —
// there is no in-process command registry left in `packages/server` at all
// ([E4.T9]/F7) to compare it against. What keeps it honest now is a
// bidirectional set comparison between `docs/spec/cli.md`'s own `` ## `name` ``
// section headings (the Rust binary's authoritative command list) and this
// document's `## <name>` section headings: either side having something the
// other lacks is a failure, which is what a generated document's
// staleness-detection would have given for free. `docs/spec/cli.md` has 81
// such headings, matching `reference/commands.md`'s own 81 (verified in the
// [E4.T9]/F7 plan).

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
 * behind). A command name is never a prefix of another (verified in the
 * NOOP-234 plan), so an exact-string comparison is enough — no markdown
 * parsing of heading structure beyond the heading line itself is needed.
 *
 * [E4.T9]/F7: this same function also proves its own bidirectionality
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

describe("[NOOP-238] reference/commands.md covers every co-motion binary command (A13)", () => {
  it("has exactly one H2 section per docs/spec/cli.md command name, both directions", async () => {
    const headings = extractHeadings(await readCommandsReference());
    expect(diffCommandNames(specCommandNames, headings)).toEqual({ undocumented: [], stale: [] });
  });
});

describe("[NOOP-238] reference/commands.md section structure (A14)", () => {
  it("gives every command section a 參數/用途/範例 field, not just a bare heading", async () => {
    const markdown = await readCommandsReference();
    const headings = extractHeadings(markdown);
    expect(headings.length).toBeGreaterThan(0);
    const sections = markdown.split(/^## /m).slice(1);
    expect(sections).toHaveLength(headings.length);
    for (const section of sections) {
      const name = section.split("\n", 1)[0].trim();
      expect(section, `${name} 缺少 **參數**`).toMatch(/\*\*參數\*\*/);
      expect(section, `${name} 缺少 **用途**`).toMatch(/\*\*用途\*\*/);
      expect(section, `${name} 缺少 **範例**`).toMatch(/\*\*範例\*\*/);
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

describe("[NOOP-238] 編輯規約 and reference/commands.md stay consistent (A16, A17, A18)", () => {
  const presentationId = "test-presentation-id";
  const brief = buildEditorialBrief(presentationId);

  /** `docs/spec/cli.md` command names that literally appear in `text`. Safe as a plain substring test: no command name is a prefix of another (verified in the NOOP-234 plan). */
  function commandsMentionedIn(text: string): string[] {
    return specCommandNames.filter((name) => text.includes(name));
  }

  it("names only commands that actually exist in docs/spec/cli.md (A16)", () => {
    const mentioned = commandsMentionedIn(brief);
    const specNames = new Set(specCommandNames);
    for (const name of mentioned) {
      expect(specNames.has(name)).toBe(true);
    }
  });

  it("names only commands that also have a reference/commands.md section (A17)", async () => {
    const headings = new Set(extractHeadings(await readCommandsReference()));
    for (const name of commandsMentionedIn(brief)) {
      expect(headings.has(name), `${name} 在編輯規約提到，但 reference/commands.md 沒有這一節`).toBe(true);
    }
  });

  it("has been slimmed to name only `text set` and `comment list` as syntax examples (A18)", () => {
    expect(commandsMentionedIn(brief).sort()).toEqual(["comment list", "text set"]);
    expect(brief).toContain("reference/commands.md");
  });

  // [E3.T6] #236/#237: same guarantee as A16/A17 above, extended to the
  // work directory's own documentation — AGENTS.md and the shipped
  // SKILL.md files reference `co-motion` commands too, and those mentions
  // must stay real (in docs/spec/cli.md) and documented (in this same file).
  it("AGENTS.md and every shipped SKILL.md name only commands that exist in docs/spec/cli.md and are documented (A4)", async () => {
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
        expect(headings.has(name), `${name} 在工作目錄文件提到，但 reference/commands.md 沒有這一節`).toBe(true);
      }
    }
  });
});
