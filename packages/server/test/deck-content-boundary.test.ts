// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(packageRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

it("keeps the legacy registry and deck-file save path behind the Rust deck server", async () => {
  const obsoleteModules = ["src/save-state.ts", "src/slidra/save-state.ts"];
  const modulesStillPresent = [];
  for (const modulePath of obsoleteModules) {
    if (await exists(modulePath)) modulesStillPresent.push(modulePath);
  }

  const homeSource = await readFile(path.join(packageRoot, "src/slidra/home.ts"), "utf8");
  const forbiddenRegistrySymbols = [
    "readProjectsRegistry",
    "writeProjectsRegistry",
    "deckPathFor",
    "deckFileMtime",
  ].filter((symbol) => homeSource.includes(symbol));

  expect({ modulesStillPresent, forbiddenRegistrySymbols }).toEqual({
    modulesStillPresent: [],
    forbiddenRegistrySymbols: [],
  });
});
