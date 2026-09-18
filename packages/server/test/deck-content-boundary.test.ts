// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const checker = path.join(packageRoot, "scripts/check-deck-boundary.mjs");
const run = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(nodeSource: string, rustSource = "pub fn clean() {}") {
  const root = await mkdtemp(path.join(os.tmpdir(), "slidra-boundary-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "packages/example/src"), { recursive: true });
  await mkdir(path.join(root, "crates/slidra/src"), { recursive: true });
  await writeFile(path.join(root, "packages/example/src/example.ts"), nodeSource);
  await writeFile(path.join(root, "crates/slidra/src/lib.rs"), rustSource);
  return root;
}

it("passes for the repository's production sources", async () => {
  await expect(run(process.execPath, [checker, packageRoot])).resolves.toMatchObject({
    stdout: expect.stringContaining("Deck boundary check passed"),
  });
});

it("rejects a rogue Node production module that reads a .slidra directly", async () => {
  const root = await fixture('import { readFile } from "node:fs/promises";\nexport const rogue = readFile("rogue.slidra");\n');
  await expect(run(process.execPath, [checker, root])).rejects.toMatchObject({ code: 1 });
});

it("rejects a Rust production module that restores legacy state", async () => {
  const root = await fixture("export const clean = true;\n", "pub fn rogue() { let _ = workspace::registry::lookup(\"x\"); }\n");
  await expect(run(process.execPath, [checker, root])).rejects.toMatchObject({ code: 1 });
});
