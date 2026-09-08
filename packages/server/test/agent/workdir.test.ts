import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentWorkdirTarget,
  classifyAgentReadPath,
  deployAgentWorkdir,
  readAgentWorkdirFile,
  resolveAgentWorkdirSource,
} from "../../src/agent/workdir.js";

// NOOP-238: the product work directory `co-motion serve` deploys on every
// startup (`packages/server/agent-workdir/` -> `<CO_MOTION_HOME>/agent`) and
// the agent session reads real files from, alongside the presentation's own
// virtual tree. No server, no ACP subprocess — everything here is a plain
// filesystem check.

let coMotionHome: string;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-workdir-home-"));
  process.env.CO_MOTION_HOME = coMotionHome;
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Every file under `dir`, as a sorted list of paths relative to `dir` (posix-style, for stable comparison across platforms). */
async function listFilesRecursively(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  }
  await walk(dir, "");
  return out.sort();
}

describe("resolveAgentWorkdirSource", () => {
  it("does not ship a top-level entry that would collide with a presentation virtual prefix (project.json/slides/assets/fonts)", async () => {
    const entries = await readdir(resolveAgentWorkdirSource());
    for (const collision of ["project.json", "slides", "assets", "fonts"]) {
      expect(entries).not.toContain(collision);
    }
  });
});

describe("deployAgentWorkdir", () => {
  it("deploys the source's files to <CO_MOTION_HOME>/agent, byte-for-byte (A1)", async () => {
    const target = await deployAgentWorkdir();
    expect(target).toBe(await realpath(agentWorkdirTarget()));

    const source = resolveAgentWorkdirSource();
    const sourceFiles = (await listFilesRecursively(source)).filter(
      (relative) => !relative.startsWith(".agents/skills") && relative !== ".claude/skills",
    );
    for (const relative of sourceFiles) {
      const [sourceContent, targetContent] = await Promise.all([
        readFile(path.join(source, relative)),
        readFile(path.join(target, relative)),
      ]);
      expect(targetContent.equals(sourceContent)).toBe(true);
    }
  });

  it("copies .agents/skills into .claude/skills, relative paths and bytes identical (A2)", async () => {
    const target = await deployAgentWorkdir();
    const agentsSkills = await listFilesRecursively(path.join(target, ".agents", "skills"));
    const claudeSkills = await listFilesRecursively(path.join(target, ".claude", "skills"));
    expect(claudeSkills).toEqual(agentsSkills);
    for (const relative of agentsSkills) {
      const [a, b] = await Promise.all([
        readFile(path.join(target, ".agents", "skills", relative)),
        readFile(path.join(target, ".claude", "skills", relative)),
      ]);
      expect(b.equals(a)).toBe(true);
    }
  });

  it("reverts a user's edit and removes a user's extra file on the next deploy — whole-directory overwrite, not a merge (A3)", async () => {
    await deployAgentWorkdir();
    const target = agentWorkdirTarget();
    await writeFile(path.join(target, "AGENTS.md"), "使用者亂改的內容");
    await mkdir(path.join(target, "多出來的目錄"), { recursive: true });
    await writeFile(path.join(target, "多出來的目錄", "多出來的檔案.md"), "不應該留下來");

    await deployAgentWorkdir();

    const sourceAgentsMd = await readFile(path.join(resolveAgentWorkdirSource(), "AGENTS.md"), "utf8");
    const deployedAgentsMd = await readFile(path.join(target, "AGENTS.md"), "utf8");
    expect(deployedAgentsMd).toBe(sourceAgentsMd);

    await expect(readdir(path.join(target, "多出來的目錄"))).rejects.toThrow();
  });

  it("is idempotent: deploying twice in a row leaves the same files behind", async () => {
    const first = await deployAgentWorkdir();
    const firstFiles = await listFilesRecursively(first);
    const second = await deployAgentWorkdir();
    const secondFiles = await listFilesRecursively(second);
    expect(second).toBe(first);
    expect(secondFiles).toEqual(firstFiles);
  });
});

describe("classifyAgentReadPath", () => {
  const workdirReal = "/deployed/agent";

  it("classifies a relative path whose first segment is a presentation virtual prefix", () => {
    expect(classifyAgentReadPath("slides/001.svg", workdirReal)).toEqual({
      kind: "presentation",
      virtualPath: "slides/001.svg",
    });
    expect(classifyAgentReadPath("project.json", workdirReal)).toEqual({
      kind: "presentation",
      virtualPath: "project.json",
    });
  });

  it("classifies a relative path with no matching prefix as a work-directory read", () => {
    expect(classifyAgentReadPath("CLAUDE.md", workdirReal)).toEqual({ kind: "workdir", relativePath: "CLAUDE.md" });
    expect(classifyAgentReadPath("reference/commands.md", workdirReal)).toEqual({
      kind: "workdir",
      relativePath: "reference/commands.md",
    });
  });

  it("translates an absolute path under the work directory back to a relative path, then classifies it the same way", () => {
    expect(classifyAgentReadPath(`${workdirReal}/CLAUDE.md`, workdirReal)).toEqual({
      kind: "workdir",
      relativePath: "CLAUDE.md",
    });
    expect(classifyAgentReadPath(`${workdirReal}/slides/001.svg`, workdirReal)).toEqual({
      kind: "presentation",
      virtualPath: "slides/001.svg",
    });
  });

  it("refuses an absolute path outside the work directory, and the work directory itself", () => {
    expect(classifyAgentReadPath("/etc/passwd", workdirReal)).toEqual({ kind: "refused" });
    expect(classifyAgentReadPath(workdirReal, workdirReal)).toEqual({ kind: "refused" });
  });
});

describe("readAgentWorkdirFile", () => {
  let workdirReal: string;

  beforeEach(async () => {
    workdirReal = await mkdtemp(path.join(tmpdir(), "co-motion-workdir-read-"));
    await writeFile(path.join(workdirReal, "CLAUDE.md"), "@AGENTS.md\n");
    await mkdir(path.join(workdirReal, "reference"));
    await writeFile(path.join(workdirReal, "reference", "commands.md"), "# 命令參考\n");
  });

  afterEach(async () => {
    await rm(workdirReal, { recursive: true, force: true });
  });

  it("reads a real file's exact content", async () => {
    expect(await readAgentWorkdirFile(workdirReal, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(await readAgentWorkdirFile(workdirReal, "reference/commands.md")).toBe("# 命令參考\n");
  });

  it("refuses an empty path (or one made only of '/'/'.') as not-found, never as 'not a file' (A12)", async () => {
    await expect(readAgentWorkdirFile(workdirReal, "")).rejects.toMatchObject({ message: "找不到檔案：" });
    await expect(readAgentWorkdirFile(workdirReal, "/")).rejects.toMatchObject({ message: "找不到檔案：/" });
    await expect(readAgentWorkdirFile(workdirReal, ".")).rejects.toMatchObject({ message: "找不到檔案：." });
  });

  it("refuses a '..' escape as not-found — '..' is just a name the real directory tree never contains (A12)", async () => {
    await expect(readAgentWorkdirFile(workdirReal, "../outside.txt")).rejects.toMatchObject({
      message: "找不到檔案：../outside.txt",
    });
  });

  it("refuses a symlink that points outside the work directory — excluded structurally, never followed (A12)", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "co-motion-workdir-outside-"));
    try {
      await writeFile(path.join(outsideDir, "secret.txt"), "不應該讀得到");
      await symlink(path.join(outsideDir, "secret.txt"), path.join(workdirReal, "link.txt"));
      await expect(readAgentWorkdirFile(workdirReal, "link.txt")).rejects.toMatchObject({
        message: "找不到檔案：link.txt",
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses a genuinely absent path as not-found", async () => {
    await expect(readAgentWorkdirFile(workdirReal, "does/not/exist.md")).rejects.toMatchObject({
      message: "找不到檔案：does/not/exist.md",
    });
  });

  it("reports a directory as 'not a file', not as absent (A12)", async () => {
    await expect(readAgentWorkdirFile(workdirReal, "reference")).rejects.toMatchObject({
      message: "不是檔案：reference",
    });
  });

  it("reports a non-UTF-8 file as a binary asset, not as decoded (possibly corrupted) text (A12)", async () => {
    await writeFile(path.join(workdirReal, "binary.dat"), Buffer.from([0xff, 0x00, 0x01]));
    await expect(readAgentWorkdirFile(workdirReal, "binary.dat")).rejects.toMatchObject({
      message: "binary.dat 是二進位資產，無法以文字讀取",
    });
  });
});
