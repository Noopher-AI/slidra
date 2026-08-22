import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError } from "./errors.js";
import { generateOpaqueId } from "./id.js";
import { buildMinimalPresentation } from "./presentation.js";
import { packDirectory, unpackContainer } from "./container.js";
import { listVirtualEntries, readVirtualFile } from "./virtual-fs.js";

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

interface RegistryEntry {
  workDir: string;
}

// A Map cannot resolve inherited Object.prototype properties (`toString`,
// `constructor`, `__proto__`, ...) by key — unlike a plain object, `.get()`
// only ever returns an entry that was actually `.set()`. This makes an id
// that happens to collide with a prototype property name structurally
// impossible to mistake for a registry entry.
type Registry = Map<string, RegistryEntry>;

/**
 * Reads and parses the registry. Only a genuinely missing file is treated as
 * an empty registry — every other failure (malformed JSON, permission
 * denied, any I/O error) is an explicit error, never a silent fallback to
 * empty, because that would make every previously opened presentation
 * unreachable the next time `open` writes the registry back out.
 */
async function readRegistry(home: string): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(registryPath(home), "utf-8");
  } catch (error) {
    if (isEnoent(error)) {
      return new Map();
    }
    throw new CoMotionError("無法讀取簡報登記資料");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError("簡報登記資料已損毀");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CoMotionError("簡報登記資料已損毀");
  }

  // Validate every entry's shape individually. A malformed entry (missing
  // workDir, wrong type, ...) must fail loudly here — leaving it in the
  // registry would surface as `undefined` deep inside whatever command
  // happens to look it up next, instead of at the point of the real
  // problem (no fallbacks).
  const registry: Registry = new Map();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isRegistryEntry(value)) {
      throw new CoMotionError(`簡報登記資料已損毀：${id}`);
    }
    registry.set(id, value);
  }

  return registry;
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "workDir" in value &&
    typeof (value as { workDir: unknown }).workDir === "string"
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Writes the registry atomically: the full content is written to a private
 * temp file first, and only a successful write is `rename`d over the real
 * `projects.json`. `rename` on the same filesystem is atomic, so a crash or
 * a full disk mid-write can never leave `projects.json` truncated or
 * half-written — the existing file is either replaced whole or untouched.
 */
async function writeRegistry(home: string, registry: Registry): Promise<void> {
  await mkdir(home, { recursive: true });
  const serialized = Object.fromEntries(registry);
  const finalPath = registryPath(home);
  const tempPath = path.join(home, `.projects.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(serialized, null, 2)}\n`);
    await rename(tempPath, finalPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new CoMotionError("無法寫入簡報登記資料");
  }
}

async function lookupWorkDir(home: string, id: string): Promise<string> {
  const registry = await readRegistry(home);
  const entry = registry.get(id);
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

  // unpackContainer succeeded, so workDir now holds real content on disk.
  // If registering it fails for any reason (corrupt registry, failed
  // write, ...), that content must not become an orphan directory nobody
  // can reach — roll the unpack back out.
  try {
    const registry = await readRegistry(home);
    registry.set(id, { workDir });
    await writeRegistry(home, registry);
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

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
 * Reads a file's complete original content inside the presentation
 * identified by `id`, addressed by its virtual path (e.g. "project.json",
 * "slides/001.svg"). The virtual path space is a mapping built by
 * enumerating the presentation's real files (see virtual-fs.ts) — a path
 * either resolves to a discovered file or it does not exist. There is no
 * real filesystem path for the caller to construct or escape through
 * (ADR-0004, third layer).
 */
export async function readPresentationFile(id: string, virtualPath: string): Promise<string> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  return readVirtualFile(workDir, virtualPath);
}

/**
 * Lists the entry names of the virtual directory at `virtualPath` (the
 * top level when omitted) inside the presentation identified by `id`.
 */
export async function listPresentationEntries(id: string, virtualPath?: string): Promise<string[]> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  return listVirtualEntries(workDir, virtualPath);
}
