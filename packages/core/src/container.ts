import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { CoMotionError } from "./errors.js";

const REQUIRED_DIRS = ["slides", "assets"];

/**
 * Recursively zips every file under `sourceDir` into a `.comot` container at
 * `outputPath`. `slides/` and `assets/` are guaranteed to exist as entries
 * even when empty, per ADR-0003.
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
 * has a readable project.json with a formatVersion before trusting it.
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
  } catch {
    // targetDir is the hidden work directory (ADR-0004) — never quote it,
    // even when the failure is a plain permission/I-O error.
    throw new CoMotionError(`無法解壓縮簡報檔案：${comotPath}`);
  }

  await validateProjectJson(targetDir, comotPath);
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

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("formatVersion" in parsed) ||
    typeof (parsed as { formatVersion: unknown }).formatVersion !== "number"
  ) {
    throw new CoMotionError(`project.json 缺少 formatVersion：${comotPath}`);
  }
}
