#!/usr/bin/env node
// `co-motion pack <presentation-id> <path>` packs an ALREADY-OPEN
// presentation, not an arbitrary directory (`docs/spec/cli.md`'s `pack`
// entry) — there is no CLI command for "zip this directory into a
// `.comot`" and this ticket deliberately does not add one (plan section
// 0.4: the 81 registered commands are a frozen contract). This script is
// the replacement for the (deleted) `packages/core`'s `packDirectory`, kept
// as a standalone script rather than a new command for exactly that
// reason — `quick_start.sh`'s demo-deck packing and the e2e suite's fixture
// packing both need it, neither is a CLI user.
//
// The body below is ported byte-for-byte (same REQUIRED_DIRS, same empty-
// directory placeholder entries, same zip level) from the deleted
// `packages/core/src/container.ts`'s `packDirectory` — deliberately NOT
// "improved" in the port, since that would change the zipped bytes of every
// existing `.comot` fixture this repo's tests compare against.

import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const REQUIRED_DIRS = ["slides", "assets", "fonts"];

/**
 * Recursively zips every file under `sourceDir` into a `.comot` container at
 * `outputPath`. `slides/`, `assets/`, and `fonts/` are guaranteed to exist as
 * entries even when empty — the first two per ADR-0003, `fonts/` per its
 * ADR-0016 amendment.
 */
export async function packDirectory(sourceDir, outputPath) {
  const zippable = {};
  try {
    await collectFiles(sourceDir, sourceDir, zippable);
  } catch {
    // sourceDir is either a private staging directory or the hidden work
    // directory (ADR-0004) — never quote it.
    throw new Error("讀取簡報內容時發生錯誤");
  }

  for (const dir of REQUIRED_DIRS) {
    const dirEntryKey = `${dir}/`;
    const hasEntry = Object.keys(zippable).some((key) => key === dirEntryKey || key.startsWith(dirEntryKey));
    if (!hasEntry) {
      zippable[dirEntryKey] = new Uint8Array(0);
    }
  }

  const zipped = zipSync(zippable, { level: 6 });
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, zipped);
  } catch {
    throw new Error(`無法寫入簡報檔案：${outputPath}`);
  }
}

async function collectFiles(root, currentDir, zippable) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, zippable);
    } else if (entry.isFile()) {
      zippable[relativePath] = await readFile(fullPath);
    }
  }
}

// CLI usage (`node scripts/pack-directory.mjs <source-dir> <output.comot>`),
// used by `quick_start.sh`'s demo-deck packing step. Only runs when this
// file is the process entry point, not when imported (e2e's
// `e2e/helpers/pack.ts`).
// `import.meta.url` is the realpath-resolved, percent-encoded URL of this
// file; `process.argv[1]` is the path as spelled on the command line. A
// string compare between them silently answers "not the entry point" the
// moment the two spellings differ — a symlinked repo path, or a path
// needing URL-encoding — and then this script exits 0 having packed
// nothing. `quick_start.sh` passes "$ROOT/scripts/pack-directory.mjs", so
// on a machine reaching the repo through a symlink the demo deck never got
// repacked and the next step failed with a misleading "找不到簡報檔案".
// Compare realpaths instead, which is what the question actually means.
if (await isEntryPoint()) {
  const [sourceDir, outputPath] = process.argv.slice(2);
  await packDirectory(sourceDir, outputPath);
}

async function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return (await realpath(fileURLToPath(import.meta.url))) === (await realpath(process.argv[1]));
  } catch {
    // argv[1] is not a real path (`node --eval`, a REPL): not this file.
    return false;
  }
}
