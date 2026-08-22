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
  await collectFiles(sourceDir, sourceDir, zippable);

  for (const dir of REQUIRED_DIRS) {
    const dirEntryKey = `${dir}/`;
    const hasEntry = Object.keys(zippable).some((key) => key === dirEntryKey || key.startsWith(dirEntryKey));
    if (!hasEntry) {
      zippable[dirEntryKey] = new Uint8Array(0);
    }
  }

  const zipped = zipSync(zippable, { level: 6 });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, zipped);
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

  const raw = await readFile(comotPath);
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(raw));
  } catch {
    throw new CoMotionError(`簡報檔案已損壞，無法解壓：${comotPath}`);
  }

  await mkdir(targetDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(unzipped)) {
    if (relativePath.endsWith("/")) {
      await mkdir(path.join(targetDir, relativePath), { recursive: true });
      continue;
    }
    const destPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, content);
  }

  for (const dir of REQUIRED_DIRS) {
    await mkdir(path.join(targetDir, dir), { recursive: true });
  }

  await validateProjectJson(targetDir, comotPath);
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
