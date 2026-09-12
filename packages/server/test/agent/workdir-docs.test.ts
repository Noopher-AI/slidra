import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectSlashCommands, parseSkillFrontmatter } from "../../src/agent/commands.js";
import { resolveAgentWorkdirSource } from "../../src/agent/workdir.js";

// [E3.T6] #236/#237: the shipped skills and the AGENTS.md
// prose that indexes them are hand-written content, not generated — what
// keeps them honest is reading the real shipped directory (the same one
// `deployAgentWorkdir` copies verbatim) rather than a fixture standing in
// for it, so a future skill added straight into `agent-workdir/` without
// updating the `## Skills` table or its own frontmatter fails here.

const bundledSkillDir = path.join(resolveAgentWorkdirSource(), ".agents", "skills");
const agentsMdPath = path.join(resolveAgentWorkdirSource(), "AGENTS.md");

// Triggers live in the frontmatter `description` (the only part loaded
// before a skill fires), so the body only has to carry the ordered steps.
const REQUIRED_SKILL_SECTIONS = ["## 步驟"];

describe("[NOOP-236] shipped work directory documentation", () => {
  it("has exactly the thirteen shipped skills, each well-formed, and reported by collectSlashCommands (A2/A3/A6)", async () => {
    const entries = await readdir(bundledSkillDir, { withFileTypes: true });
    const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    // The `slidra-` namespace lives in the directory name itself, so the
    // name an author types is the name the agent registered (#248).
    expect(dirNames.sort()).toEqual(["slidra-animate", "slidra-background-kit", "slidra-build", "slidra-chart", "slidra-layout-kit", "slidra-new-slide", "slidra-notes", "slidra-plan", "slidra-reshape", "slidra-style", "slidra-style-kit", "slidra-table", "slidra-validate"]);

    for (const dirName of dirNames) {
      const text = await readFile(path.join(bundledSkillDir, dirName, "SKILL.md"), "utf8");
      const { name, description } = parseSkillFrontmatter(text, dirName);
      expect(name).toBe(dirName);
      expect(description.length).toBeGreaterThan(0);
      for (const section of REQUIRED_SKILL_SECTIONS) {
        expect(text, `${dirName}/SKILL.md missing ${section}`).toContain(section);
      }
    }

    const emptyUserDir = await mkdtemp(path.join(tmpdir(), "slidra-user-skills-"));
    try {
      const commands = await collectSlashCommands([], { bundled: bundledSkillDir, user: emptyUserDir });
      expect(commands.map((c) => c.name)).toEqual(["slidra-animate", "slidra-background-kit", "slidra-build", "slidra-chart", "slidra-layout-kit", "slidra-new-slide", "slidra-notes", "slidra-plan", "slidra-reshape", "slidra-style", "slidra-style-kit", "slidra-table", "slidra-validate"]);
      for (const command of commands) {
        expect(command.description.length).toBeGreaterThan(0);
        expect(command.source).toBe("bundled");
      }
    } finally {
      await rm(emptyUserDir, { recursive: true, force: true });
    }
  });

  it("AGENTS.md has all seven H2 sections in order, no leftover placeholder, and one Skills-table row per skill directory (A1/A5)", async () => {
    const text = await readFile(agentsMdPath, "utf8");
    expect(text).not.toContain("<!-- T6");

    const requiredOrder = ["## Slidra 是什麼", "## 環境與限制", "## 命令參考", "## 虛擬檔案結構", "## SVG 約定重點", "## 工作慣例", "## Skills"];
    let searchFrom = 0;
    for (const heading of requiredOrder) {
      const index = text.indexOf(heading, searchFrom);
      expect(index, `${heading} missing or out of order`).toBeGreaterThanOrEqual(0);
      searchFrom = index + heading.length;
    }

    const skillsSection = text.slice(text.indexOf("## Skills"));
    const entries = await readdir(bundledSkillDir, { withFileTypes: true });
    const dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const tableRows = [...skillsSection.matchAll(/^\|\s*`\/(slidra-[a-z-]+)`/gm)].map((match) => match[1]);
    expect(tableRows.sort()).toEqual(dirNames.sort());
  });
});
