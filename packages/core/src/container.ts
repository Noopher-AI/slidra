import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { CoMotionError } from "./errors.js";
import { validateProjectJson as validateProjectJsonStructure, assertSupportedFormatVersion } from "./project-json.js";

const REQUIRED_DIRS = ["slides", "assets", "fonts"];

/**
 * Recursively zips every file under `sourceDir` into a `.comot` container at
 * `outputPath`. `slides/`, `assets/`, and `fonts/` are guaranteed to exist as
 * entries even when empty — the first two per ADR-0003, `fonts/` per its
 * ADR-0016 amendment.
 */
export async function packDirectory(sourceDir: string, outputPath: string): Promise<void> {
  const zippable: Zippable = {};
  try {
    await collectFiles(sourceDir, sourceDir, zippable);
  } catch {
    // sourceDir is either a private staging directory or the hidden work
    // directory (ADR-0004) — never quote it.
    throw new CoMotionError("讀取簡報內容時發生錯誤");
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
    throw new CoMotionError(`無法寫入簡報檔案：${outputPath}`);
  }
}

async function collectFiles(root: string, currentDir: string, zippable: Zippable): Promise<void> {
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

/**
 * Unzips a `.comot` container into `targetDir`. Validates that the container
 * has a readable, structurally valid project.json before trusting it — the
 * same structural check `serve` runs on its own copy of project.json, so a
 * container missing e.g. `slides` fails here, at open time, instead of
 * surviving to explode inside `serve` (ticket #12).
 */
export async function unpackContainer(comotPath: string, targetDir: string): Promise<void> {
  let comotStats;
  try {
    comotStats = await stat(comotPath);
  } catch {
    throw new CoMotionError(`找不到簡報檔案：${comotPath}`);
  }
  if (!comotStats.isFile()) {
    throw new CoMotionError(`指定的路徑不是檔案：${comotPath}`);
  }

  let raw: Buffer;
  try {
    raw = await readFile(comotPath);
  } catch {
    throw new CoMotionError(`無法讀取簡報檔案：${comotPath}`);
  }
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(raw));
  } catch {
    throw new CoMotionError(`簡報檔案已損壞，無法解壓：${comotPath}`);
  }

  // Validate every entry before writing anything: a partially-unpacked
  // malicious archive is still a breach, so a bad entry must fail the whole
  // unpack rather than being skipped or silently sanitised.
  const resolvedTargetDir = path.resolve(targetDir);
  for (const relativePath of Object.keys(unzipped)) {
    assertEntryWithinTarget(relativePath, resolvedTargetDir, comotPath);
  }

  try {
    await mkdir(targetDir, { recursive: true });

    for (const [relativePath, content] of Object.entries(unzipped)) {
      const destPath = path.join(targetDir, relativePath);
      if (relativePath.endsWith("/")) {
        await mkdir(destPath, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, content);
    }

    for (const dir of REQUIRED_DIRS) {
      await mkdir(path.join(targetDir, dir), { recursive: true });
    }

    // Validate before this function is considered to have succeeded: an
    // archive that unzips fine but lacks a usable project.json is still a
    // failed unpack, and must not leave targetDir behind (see catch below).
    await validateProjectJson(targetDir, comotPath);
  } catch (error) {
    // targetDir is a fresh directory created solely for this unpack (the
    // hidden work directory, ADR-0004). On any failure past this point —
    // I/O error or a bad project.json — remove it so repeatedly opening an
    // invalid container never accumulates orphan directories on disk.
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof CoMotionError) {
      throw error;
    }
    // targetDir is the hidden work directory (ADR-0004) — never quote it,
    // even when the failure is a plain permission/I-O error.
    throw new CoMotionError(`無法解壓縮簡報檔案：${comotPath}`);
  }
}

/**
 * Rejects an archive entry that is absolute or whose resolved destination
 * falls outside `resolvedTargetDir`. This is the unpack-side counterpart of
 * the traversal guard `readPresentationFile` applies on the read side.
 */
function assertEntryWithinTarget(entryPath: string, resolvedTargetDir: string, comotPath: string): void {
  if (path.isAbsolute(entryPath)) {
    throw new CoMotionError(`簡報檔案內含不合法的路徑：${comotPath}`);
  }
  const resolvedDest = path.resolve(resolvedTargetDir, entryPath);
  if (resolvedDest !== resolvedTargetDir && !resolvedDest.startsWith(resolvedTargetDir + path.sep)) {
    throw new CoMotionError(`簡報檔案內含不合法的路徑：${comotPath}`);
  }
}

async function validateProjectJson(workDir: string, comotPath: string): Promise<void> {
  const projectJsonPath = path.join(workDir, "project.json");
  let raw: string;
  try {
    raw = await readFile(projectJsonPath, "utf-8");
  } catch {
    throw new CoMotionError(`簡報檔案缺少 project.json：${comotPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError(`project.json 不是合法的 JSON：${comotPath}`);
  }

  // The structural check itself never mentions comotPath (ADR-0004: the
  // shared validator in packages/core/src/project-json.ts is used verbatim
  // by both open and serve, and serve has no .comot path to echo). Kept
  // path-free here too rather than appended, so both callers report the
  // exact same wording for the exact same malformed field.
  const project = validateProjectJsonStructure(parsed);
  assertSupportedFormatVersion(project);
}
