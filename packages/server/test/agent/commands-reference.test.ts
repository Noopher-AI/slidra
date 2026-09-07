import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CommandRegistry, createDefaultRegistry } from "@co-motion/cli";
import { buildEditorialBrief } from "../../src/agent/brief.js";

// NOOP-238: `reference/commands.md` is hand-written, not generated —
// `CommandDefinition` carries no name/parameter/purpose metadata to
// generate a document from (see `packages/cli/src/registry.ts`). What keeps
// it honest is a bidirectional set comparison between the registry's own
// command names and the document's `## <name>` section headings: either
// side having something the other lacks is a failure, which is what a
// generated document's staleness-detection would have given for free.

const commandsReferencePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-workdir/reference/commands.md",
);

async function readCommandsReference(): Promise<string> {
  return readFile(commandsReferencePath, "utf8");
}

/** Every `## <name>` heading, in document order — the document's own claimed command list. */
function extractHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
}

/**
 * The two-way diff `commands-reference.test.ts` is built around: names only
 * the registry has (undocumented) and names only the document has (stale —
 * renamed or removed from the registry, but a section was left behind).
 * A registry name is never a prefix of another (verified in the NOOP-234
 * plan), so an exact-string comparison is enough — no markdown parsing of
 * heading structure beyond the heading line itself is needed.
 */
function diffCommandNames(registryNames: string[], documentHeadings: string[]): { undocumented: string[]; stale: string[] } {
  const registrySet = new Set(registryNames);
  const documentSet = new Set(documentHeadings);
  return {
    undocumented: registryNames.filter((name) => !documentSet.has(name)),
    stale: documentHeadings.filter((name) => !registrySet.has(name)),
  };
}

describe("[NOOP-238] reference/commands.md covers every registered command (A13)", () => {
  it("has exactly one H2 section per registry command name, both directions", async () => {
    const registryNames = createDefaultRegistry().names();
    const headings = extractHeadings(await readCommandsReference());
    expect(diffCommandNames(registryNames, headings)).toEqual({ undocumented: [], stale: [] });
  });

  it("would report a command the registry has and the document doesn't (A15 — the comparison itself, not commands.ts)", () => {
    const registry = new CommandRegistry();
    registry.register("probe only in registry", { handler: async () => ({ ok: true, message: "" }), render: null });
    const diff = diffCommandNames(registry.names(), ["existing command"]);
    expect(diff.undocumented).toEqual(["probe only in registry"]);
    expect(diff.stale).toEqual(["existing command"]);
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
    const registryNames = new Set(createDefaultRegistry().names());
    for (const heading of extractHeadings(markdown)) {
      expect(registryNames.has(heading)).toBe(true);
    }
  });
});

describe("[NOOP-238] 編輯規約 and reference/commands.md stay consistent (A16, A17, A18)", () => {
  const presentationId = "test-presentation-id";
  const brief = buildEditorialBrief(presentationId);
  const registryNames = createDefaultRegistry().names();

  /** Registry command names that literally appear in `text`. Safe as a plain substring test: no registry name is a prefix of another (verified in the NOOP-234 plan). */
  function commandsMentionedIn(text: string): string[] {
    return registryNames.filter((name) => text.includes(name));
  }

  it("names only commands that actually exist in the registry (A16)", () => {
    const mentioned = commandsMentionedIn(brief);
    const registrySet = new Set(registryNames);
    for (const name of mentioned) {
      expect(registrySet.has(name)).toBe(true);
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
});
