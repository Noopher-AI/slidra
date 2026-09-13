// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles, findViolations, loadKnownScripts } from "../check-doc-commands.mjs";

describe("check-doc-commands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "check-doc-commands-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when every referenced npm script exists", async () => {
    await writeFile(path.join(dir, "README.md"), "Run `npm run build` then `npm run test`.\n");

    const knownScripts = loadKnownScripts(dir);
    const violations = findViolations(collectFiles(dir), knownScripts, dir);

    expect(violations).toEqual([]);
  });

  it("reports the file and line of a non-existent npm script", async () => {
    await writeFile(path.join(dir, "README.md"), "Line one.\nRun `npm run serve` to start.\n");

    const knownScripts = loadKnownScripts(dir);
    const violations = findViolations(collectFiles(dir), knownScripts, dir);

    expect(violations).toEqual([{ file: "README.md", line: 2, scriptName: "serve" }]);
  });

  it("throws instead of silently skipping an unreadable directory", () => {
    expect(() => collectFiles(path.join(dir, "does-not-exist"))).toThrow();
  });
});
