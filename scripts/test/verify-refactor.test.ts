// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../verify_refactor.sh");

// Old blob: two records-to-be, each declared on its own line.
const OLD = [
  "const selectedIds = [];",
  "line A",
  "line B",
  "use(selectedIds);",
  "line C",
  "const hoveredId = null;",
  "line D",
  "line E",
  "use(hoveredId);",
  "line F",
].join("\n");

// New blob: the same file after renaming both bindings. The two declaration
// lines (1 and 6) cannot be produced by reverse substitution, so they are what
// the Rename-exempt trailer covers -- TWO ranges on the new side.
const newBlob = (lineE: string) =>
  [
    "const selection = { ids: [] };",
    "line A",
    "line B",
    "use(selection.ids);",
    "line C",
    "const hover = { id: null };",
    "line D",
    lineE,
    "use(hover.id);",
    "line F",
  ].join("\n");

const MESSAGE = [
  "refactor: group ids into records",
  "",
  "Rename-map:",
  "  selectedIds -> selection.ids",
  "  hoveredId -> hover.id",
  "",
  "Rename-exempt:",
  "  f.ts:1-1",
  "  f.ts:6-6",
  "  f.ts:old:1-1",
  "  f.ts:old:6-6",
].join("\n");

let repo: string | undefined;

function makeRepo(lineE: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-refactor-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "f.ts"), `${OLD}\n`);
  git("add", "f.ts");
  git("commit", "-q", "-m", "base");
  writeFileSync(path.join(dir, "f.ts"), `${newBlob(lineE)}\n`);
  git("add", "f.ts");
  git("commit", "-q", "-m", MESSAGE);
  return dir;
}

function runRenamed(dir: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(script, ["renamed", "HEAD"], { cwd: dir, encoding: "utf8" });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

describe("verify_refactor.sh renamed", () => {
  it("passes a faithful rename whose Rename-exempt has two ranges per side", () => {
    repo = makeRepo("line E");

    const { status, output } = runRenamed(repo);

    expect(output).toContain("OK");
    expect(status).toBe(0);
  });

  it("fails when a line outside the exempt ranges was changed", () => {
    repo = makeRepo("line E CHANGED");

    const { status, output } = runRenamed(repo);

    expect(status).not.toBe(0);
    expect(output).toContain("residual diff");
  });
});
