// Builds the conformance suite from conformance/cases.mjs: one deck per case
// under conformance/decks/, and conformance/manifest.json with every case's
// expectation. Needs Node >= 22.5 (node:sqlite).
//
//   node --no-warnings tools/build-conformance.mjs [--out dir]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, manifest } from "../conformance/cases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
const OUT = outFlag === -1 ? path.join(ROOT, "conformance") : path.resolve(process.argv[outFlag + 1]);

const ids = new Set();
for (const { id } of CASES) {
  if (ids.has(id)) throw new Error(`duplicate case id ${id}`);
  ids.add(id);
}

rmSync(path.join(OUT, "decks"), { recursive: true, force: true });
mkdirSync(path.join(OUT, "decks"), { recursive: true });
for (const item of CASES) writeFileSync(path.join(OUT, "decks", `${item.id}.slidra`), item.build());
writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
console.log(`wrote ${CASES.length} cases to ${path.relative(process.cwd(), OUT) || "."}`);
