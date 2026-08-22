import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CoMotionError } from "./errors.js";
import { generateOpaqueId } from "./id.js";
import { buildMinimalPresentation } from "./presentation.js";
import { packDirectory, unpackContainer } from "./container.js";

/**
 * Resolves CO_MOTION_HOME, defaulting to ~/.comotion. Read fresh on every
 * call (not cached) so tests can point it at a temp directory per test.
 */
export function resolveCoMotionHome(): string {
  return process.env.CO_MOTION_HOME ?? path.join(homedir(), ".comotion");
}

function workDirFor(home: string, id: string): string {
  return path.join(home, "work", id);
}

function registryPath(home: string): string {
  return path.join(home, "projects.json");
}

type Registry = Record<string, { workDir: string }>;

async function readRegistry(home: string): Promise<Registry> {
  try {
    const raw = await readFile(registryPath(home), "utf-8");
    return JSON.parse(raw) as Registry;
  } catch {
    return {};
  }
}

async function writeRegistry(home: string, registry: Registry): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(registryPath(home), `${JSON.stringify(registry, null, 2)}\n`);
}

async function lookupWorkDir(home: string, id: string): Promise<string> {
  const registry = await readRegistry(home);
  const entry = registry[id];
  if (!entry) {
    throw new CoMotionError(`找不到識別碼對應的簡報：${id}`);
  }
  return entry.workDir;
}

/**
 * Creates a minimal presentation and packs it directly to `outputPath`.
 * Does not register or open the presentation.
 */
export async function createNewPresentation(outputPath: string, name: string): Promise<void> {
  const { files } = buildMinimalPresentation(name);
  const stagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-new-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const destPath = path.join(stagingDir, relativePath);
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, content, "utf-8");
    }
    await mkdir(path.join(stagingDir, "assets"), { recursive: true });
    await packDirectory(stagingDir, outputPath);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Unpacks `comotPath` into the hidden work directory and registers it under
 * a fresh opaque id. Returns only the id — never the real work directory
 * path (ADR-0004).
 */
export async function openPresentation(comotPath: string): Promise<{ id: string }> {
  const home = resolveCoMotionHome();
  const id = generateOpaqueId();
  const workDir = workDirFor(home, id);

  await unpackContainer(comotPath, workDir);

  const registry = await readRegistry(home);
  registry[id] = { workDir };
  await writeRegistry(home, registry);

  return { id };
}

/**
 * Packs the presentation identified by `id` back into a single `.comot`
 * file at `outputPath`.
 */
export async function packPresentation(id: string, outputPath: string): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await packDirectory(workDir, outputPath);
}

/**
 * Reads a text file inside the presentation identified by `id`, addressed
 * by its container-relative virtual path (e.g. "project.json",
 * "slides/001.svg"). Never accepts or returns a real filesystem path.
 */
export async function readPresentationFile(id: string, virtualPath: string): Promise<string> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);

  const normalized = path.normalize(virtualPath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new CoMotionError(`不合法的虛擬路徑：${virtualPath}`);
  }

  const targetPath = path.join(workDir, normalized);
  try {
    return await readFile(targetPath, "utf-8");
  } catch {
    throw new CoMotionError(`找不到檔案：${virtualPath}`);
  }
}

/** Lists container-relative virtual paths of files present in the presentation. */
export async function listPresentationFiles(id: string): Promise<string[]> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const results: string[] = [];
  await walk(workDir, workDir, results);
  return results.sort();
}

async function walk(root: string, currentDir: string, results: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, results);
    } else if (entry.isFile()) {
      results.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
}
