// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxRoot } from "../../src/sandbox/sandbox-root.js";

describe("createSandboxRoot", () => {
  it("gives two serves two unrelated sandbox roots", async () => {
    const a = await createSandboxRoot();
    const b = await createSandboxRoot();
    expect(a.path).not.toBe(b.path);
    expect(await stat(a.path)).toBeTruthy();
    expect(await stat(b.path)).toBeTruthy();
    await a.disposeAll();
    await b.disposeAll();
  });

  it("presentationDir nests under the root, one directory per presentation", async () => {
    const root = await createSandboxRoot();
    const a = root.presentationDir("pres-a");
    const b = root.presentationDir("pres-b");
    expect(a).toBe(path.join(root.path, "pres-a"));
    expect(b).toBe(path.join(root.path, "pres-b"));
    await root.disposeAll();
  });

  it("switching decks: disposePresentation removes only that presentation's subdirectory (AC9, first half)", async () => {
    const root = await createSandboxRoot();
    await mkdir(root.presentationDir("pres-a"), { recursive: true });
    await mkdir(root.presentationDir("pres-b"), { recursive: true });
    await writeFile(path.join(root.presentationDir("pres-a"), "note.txt"), "a");
    await writeFile(path.join(root.presentationDir("pres-b"), "note.txt"), "b");

    await root.disposePresentation("pres-a");

    await expect(stat(root.presentationDir("pres-a"))).rejects.toThrow();
    expect(await readdir(root.presentationDir("pres-b"))).toEqual(["note.txt"]);
    await root.disposeAll();
  });

  it("disposePresentation on a presentation never opened in this sandbox is a no-op, not an error", async () => {
    const root = await createSandboxRoot();
    await expect(root.disposePresentation("never-opened")).resolves.toBeUndefined();
    await root.disposeAll();
  });

  it("exiting the program: disposeAll removes the whole root, leaving nothing behind (AC9, second half)", async () => {
    const root = await createSandboxRoot();
    await mkdir(root.presentationDir("pres-a"), { recursive: true });
    await writeFile(path.join(root.presentationDir("pres-a"), "note.txt"), "a");

    await root.disposeAll();

    await expect(stat(root.path)).rejects.toThrow();
  });

  it("disposeAll is safe to call more than once", async () => {
    const root = await createSandboxRoot();
    await root.disposeAll();
    await expect(root.disposeAll()).resolves.toBeUndefined();
  });
});
