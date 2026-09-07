import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError, CoMotionInvalidRequestError, CoMotionNotFoundError } from "./errors.js";
import { generateElementId, generateOpaqueId } from "./id.js";
import { buildMinimalPresentation, type ProjectJson } from "./presentation.js";
import { readTemplateEntries } from "./project-json.js";
import { packDirectory, unpackContainer } from "./container.js";
import { listVirtualEntries, readVirtualFile, readVirtualFileBytes, resolveVirtualFilePath } from "./virtual-fs.js";
import {
  appendElementToSvg,
  escapeXmlAttr,
  escapeXmlText,
  realignTextBox,
  replaceElementText,
  resizeTextBox,
  setParagraphList,
  setTextRunStyle,
  substituteDynamicText,
  type ListKind,
  type TextRunStyleUpdate,
} from "./element-text.js";
import { setSlidePageStyle as applyPageStyle, type PageStyleUpdate } from "./slide-style.js";
import {
  deleteElements,
  insertElement,
  lockElements,
  moveElements,
  reorderElements,
  resizeElements,
  rotateElements,
  scaleElements,
  setElementStyle,
  unlockElements,
  type InsertElementInput,
  type MutationOptions,
  type OrderDirection,
  type ResizeAnchor,
} from "./element-edit.js";
import {
  commitSnapshotEntries,
  discardSnapshotEntries,
  finalizeCommittedEntries,
  revertCommittedEntries,
  stageNewFileEntry,
  stageSnapshotEntries,
} from "./history.js";
import { resolvePresentationFonts } from "./fonts.js";
import { wrapText } from "./text/wrap.js";
import { renderTextBoxContent } from "./text/render.js";
import { formatSvgNumber } from "./svg-number.js";
import { groupElements, setElementName, ungroupElements } from "./element-group.js";
import { alignElements, distributeElements, type AlignDirection, type DistributeAxis } from "./element-arrange.js";
import { extractElementsForCopy, pasteElements, type ClipboardPayload } from "./element-clipboard.js";
import {
  addEffects,
  moveEffect,
  readEffectList,
  removeEffects,
  setEffect,
  type AddEffectInput,
  type SetEffectInput,
} from "./effects/edit.js";
import type { Effect } from "./effects/index.js";
import {
  bindTableSource,
  createTableElement,
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  parseMarkdownTable,
  parseTableCsv,
  refreshTableSource,
  setTableCellStyle,
  setTableCellText,
  setTableColWidth,
  setTableFromCsv,
  setTableFromMarkdown,
  setTableHeader,
  setTableTheme,
  readTableModel,
  type CellStyleAttr,
  type CreateTableInput,
  type TableTheme,
} from "./table/index.js";
import {
  createChartElement,
  parseChartCsv,
  setChartAxis,
  setChartData,
  setChartLegend,
  setChartOption,
  setChartPalette,
  setChartStack,
  setChartType,
  type ChartAxesMode,
  type ChartLegend,
  type ChartOptionKey,
  type ChartPalette,
  type ChartType,
  type CreateChartInput,
} from "./chart/index.js";

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
  /** The `.comot` path `open` (or the GUI's `reopenPresentationInPlace`) last read from — absent for a pre-NOOP-93 registry entry. */
  sourcePath?: string;
  /**
   * The work directory's own `maxMtimeInDirectory` reading at the last
   * moment its content is known to match `sourcePath` byte-for-byte — see
   * `readSaveState` below. Absent alongside a missing `sourcePath`.
   *
   * Deliberately NOT `Date.now()` (an earlier version of this field):
   * comparing a `Date.now()` timestamp against a later `stat().mtimeMs`
   * reading mixes two different clocks whose resolutions do not agree — on
   * this project's filesystem, an mtime can round to a value *later* than a
   * `Date.now()` captured a moment afterwards, which made a
   * freshly-`open`ed presentation read back as spuriously `dirty: true`
   * (observed directly: `e2e/file-roundtrip.test.ts` failed intermittently
   * against real files before this change). Capturing the snapshot with the
   * exact same `stat`-based measurement `readSaveState` later compares
   * against removes the cross-clock mismatch entirely — this is the
   * "combination" comparison NOOP-93's plan §8 authorized if the naive
   * timestamp proved flaky.
   */
  savedAt?: number;
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
    // A genuine operational failure (permissions, a failing disk, a
    // corrupt file, ...) reading the registry itself — as opposed to the
    // file simply not existing yet (handled above). This is not evidence
    // that anything the caller asked for is absent, so it stays a plain
    // CoMotionError: only CoMotionNotFoundError is granted a 404 by
    // callers such as the /api/raw/ route, and every other CoMotionError —
    // this included — is a 500 (ticket #11, fourth fix round).
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
    throw new CoMotionNotFoundError(`找不到識別碼對應的簡報：${id}`);
  }
  return entry.workDir;
}

/**
 * Resolves an opaque presentation id to its real work directory — the one
 * place in the codebase that does this. Every id-to-path lookup (`cat`,
 * `ls`, `text set`, the raw/file HTTP routes, and the filesystem watcher)
 * goes through this, so an unreadable registry, malformed JSON, or a
 * corrupt entry always surfaces as the same `CoMotionError` /
 * `CoMotionNotFoundError` split with the same wording, never a second,
 * independently-drifting implementation of the same rule.
 */
export async function resolveWorkDir(id: string): Promise<string> {
  const home = resolveCoMotionHome();
  return lookupWorkDir(home, id);
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
      if (typeof content === "string") {
        await writeFile(destPath, content, "utf-8");
      } else {
        await writeFile(destPath, content);
      }
    }
    await mkdir(path.join(stagingDir, "assets"), { recursive: true });
    await mkdir(path.join(stagingDir, "fonts"), { recursive: true });
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
    // `sourcePath`/`savedAt` (NOOP-93): this is the one moment `open` knows
    // the work directory's content and `comotPath`'s bytes agree — the
    // presentation was just unpacked from exactly this file. `savedAt` is
    // the freshly-unpacked content's own max mtime, not `Date.now()` — see
    // `RegistryEntry.savedAt`'s comment for why.
    registry.set(id, { workDir, sourcePath: comotPath, savedAt: await maxMtimeInDirectory(workDir) });
    await writeRegistry(home, registry);
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return { id };
}

/**
 * Packs the presentation identified by `id` back into a single `.comot`
 * file at `outputPath`. When `outputPath` is the same file `open` last read
 * from (or the last successful `pack`/`save` wrote to), this is a save:
 * `savedAt` advances so `readSaveState` reports clean again (NOOP-93, §3.2).
 * Packing to any other path leaves `savedAt` untouched — that content now
 * exists in two places, but the work directory's own "last saved" moment
 * has not changed.
 */
export async function packPresentation(id: string, outputPath: string): Promise<void> {
  const home = resolveCoMotionHome();
  const registry = await readRegistry(home);
  const entry = registry.get(id);
  if (!entry) {
    throw new CoMotionNotFoundError(`找不到識別碼對應的簡報：${id}`);
  }
  await packDirectory(entry.workDir, outputPath);
  if (entry.sourcePath !== undefined && path.resolve(outputPath) === path.resolve(entry.sourcePath)) {
    registry.set(id, { ...entry, savedAt: await maxMtimeInDirectory(entry.workDir) });
    await writeRegistry(home, registry);
  }
}

/**
 * Packs presentation `id` back to the `.comot` path it was last opened
 * from — `co-motion serve`'s `POST /api/save` (NOOP-93, §4.2). A thin
 * wrapper over `packPresentation` that resolves the destination itself
 * (`entry.sourcePath`) rather than making the HTTP layer read a real
 * filesystem path out of the registry — the registry stays core's alone to
 * read. Throws before any write when there is no `sourcePath` to write to
 * (a pre-NOOP-93 registry entry, or one created by `pack`-to-arbitrary-path
 * rather than `open`): `/api/save` has no path of its own to fall back to,
 * and guessing one is exactly the fallback this project forbids.
 */
export async function savePresentation(id: string): Promise<{ fileName: string }> {
  const home = resolveCoMotionHome();
  const registry = await readRegistry(home);
  const entry = registry.get(id);
  if (!entry) {
    throw new CoMotionNotFoundError(`找不到識別碼對應的簡報：${id}`);
  }
  if (entry.sourcePath === undefined) {
    throw new CoMotionInvalidRequestError("這份簡報沒有可寫回的檔案路徑，請用 co-motion pack 指定路徑");
  }
  await packPresentation(id, entry.sourcePath);
  return { fileName: path.basename(entry.sourcePath) };
}

/**
 * Replaces presentation `id`'s work directory content in place with
 * `comotPath`'s, without changing `id` itself (NOOP-93, §7 decision 5): the
 * GUI's Open action reuses the same presentation id rather than opening a
 * second one, because `id` is woven into `startServe`'s closures
 * (`changeBroadcaster`, `AgentChatSession`, every route) and rebuilding
 * those for a fresh id is far riskier than swapping the directory's
 * content under an id that stays put.
 *
 * `comotPath` is unpacked into a fresh staging directory *inside* `home`
 * first — never `os.tmpdir()` — and only once that succeeds (a valid
 * container with a valid `project.json`) does this touch the real work
 * directory, by removing its existing children and `rename`-ing the
 * staged ones in. Staging under `home` (not the system tmp dir) keeps the
 * final move a same-filesystem `rename`, not a cross-device copy — `home`
 * and `workDirFor(home, id)` are always on one filesystem, `os.tmpdir()`
 * is not guaranteed to be.
 *
 * The work directory itself is never deleted or recreated
 * (`watch.ts:86`'s `fsWatch(workDir, { recursive: true }, ...)` holds a
 * handle on that exact inode — recreating the directory would kill the
 * live `serve` watcher out from under a running server). Only its children
 * are swapped.
 *
 * `<home>/history/<id>/` is deleted afterwards: the undo/redo stack it
 * holds refers to the presentation's *previous* content, which no longer
 * exists once this returns.
 */
export async function reopenPresentationInPlace(id: string, comotPath: string): Promise<void> {
  const home = resolveCoMotionHome();
  const registry = await readRegistry(home);
  const entry = registry.get(id);
  if (!entry) {
    throw new CoMotionNotFoundError(`找不到識別碼對應的簡報：${id}`);
  }

  await mkdir(home, { recursive: true });
  const stagingDir = await mkdtemp(path.join(home, ".reopen-"));
  try {
    await unpackContainer(comotPath, stagingDir);

    const existingChildren = await readdir(entry.workDir);
    await Promise.all(
      existingChildren.map((name) => rm(path.join(entry.workDir, name), { recursive: true, force: true })),
    );
    const stagedChildren = await readdir(stagingDir);
    await Promise.all(
      stagedChildren.map((name) => rename(path.join(stagingDir, name), path.join(entry.workDir, name))),
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  registry.set(id, { ...entry, sourcePath: comotPath, savedAt: await maxMtimeInDirectory(entry.workDir) });
  await writeRegistry(home, registry);
  await rm(path.join(home, "history", id), { recursive: true, force: true }).catch(() => {});
}

export type SaveState = { known: true; dirty: boolean; fileName: string } | { known: false };

/**
 * Reports whether presentation `id`'s work directory has changed since it
 * was last known to match `sourcePath` (NOOP-93, §3.2/§4.2). A registry
 * entry with no `sourcePath`/`savedAt` at all — every entry from before
 * this ticket — has no saved-state story yet: `{ known: false }`, not a
 * guessed `dirty: false`.
 *
 * "Changed" is the newest mtime anywhere under the work directory —
 * directories included, not just files, so a *deletion* (which leaves no
 * file of its own with a new mtime, only a parent directory whose entry
 * list just shrank) is still detected — compared with strict `>` against
 * `savedAt`; equal is clean. `savedAt` is always taken *after* the write
 * it records completed, so a genuine edit can never tie.
 */
export async function readSaveState(id: string): Promise<SaveState> {
  const home = resolveCoMotionHome();
  const registry = await readRegistry(home);
  const entry = registry.get(id);
  if (!entry) {
    throw new CoMotionNotFoundError(`找不到識別碼對應的簡報：${id}`);
  }
  if (entry.sourcePath === undefined || entry.savedAt === undefined) {
    return { known: false };
  }
  const maxMtimeMs = await maxMtimeInDirectory(entry.workDir);
  return { known: true, dirty: maxMtimeMs > entry.savedAt, fileName: path.basename(entry.sourcePath) };
}

/** The newest `mtimeMs` of `dir` itself or anything nested inside it. */
async function maxMtimeInDirectory(dir: string): Promise<number> {
  let max = (await stat(dir)).mtimeMs;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, await maxMtimeInDirectory(fullPath));
    } else if (entry.isFile()) {
      max = Math.max(max, (await stat(fullPath)).mtimeMs);
    }
  }
  return max;
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
 * Reads a file's raw bytes inside the presentation identified by `id`,
 * addressed by its virtual path — the byte-preserving sibling of
 * `readPresentationFile` (ticket #11). This is what the browser needs for
 * `assets/` content (images, video, audio); agent-facing reads stay on
 * `readPresentationFile`'s decoded text. Same lookup, same id-to-workDir
 * resolution, so it inherits the same structural containment.
 */
export async function readPresentationFileBytes(id: string, virtualPath: string): Promise<Buffer> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  return readVirtualFileBytes(workDir, virtualPath);
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

/**
 * The single door every content-writing command must use (ticket #73, AC 4).
 * Snapshots the file's current content into undo history before overwriting
 * it, so any command that writes through here gets undo for free without
 * writing its own inverse logic.
 *
 * The snapshot is *staged* (its file written) before the content write. The
 * undo group is then *committed* (history.ts's `commitSnapshotEntries`)
 * *before* the content write itself (NOOP-337, reversing this function's
 * original order): a caller that polls with a fixed delay after issuing a
 * command — the e2e suite's own `dragBy` does this — could otherwise
 * observe the new content on disk (`writeFile` had completed) before
 * `commitSnapshotEntries`'s own `writeStack` had, and see `undo` reject
 * with "沒有可復原的操作" even though the edit it means to revert is
 * already visible. Committing first closes that window: nothing makes the
 * new content visible until the undo group that reverts it is already
 * durable. If the content write itself then fails, the commit is unwound
 * (`revertCommittedEntries`) — a failed command must not occupy an undo
 * slot, and it must not leave an orphan snapshot file either (finding 2).
 */
export async function writePresentationFile(id: string, virtualPath: string, content: string): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const realPath = await resolveVirtualFilePath(workDir, virtualPath);
  const entries = await stageSnapshotEntries(id, [virtualPath]);
  const { previousStack, pendingDeletionSnapshotIds } = await commitSnapshotEntries(id, entries);
  try {
    await writeFile(realPath, content, "utf-8");
  } catch {
    await revertCommittedEntries(id, entries, previousStack);
    // realPath is a real filesystem path (ADR-0004) — never quote it.
    throw new CoMotionError(`寫入投影片時發生錯誤：${virtualPath}`);
  }
  await finalizeCommittedEntries(id, pendingDeletionSnapshotIds);
}

/**
 * The one exception door (#200 決定 4): only `presentation canvas set` uses
 * this — page size is the one edit the acceptance criteria (「Undo 可回退
 * （頁面尺寸除外）」) name as never occupying an undo step. Every other
 * write goes through `writePresentationFile` above. The difference from it
 * is exactly the snapshot/commit bracket: no `stageSnapshotEntries`/
 * `commitSnapshotEntries` call, so nothing is pushed onto the undo stack.
 * The filesystem watcher still sees the write and still fires
 * `presentation-changed` (it watches the file itself, not the history
 * stack), so the stage still updates live.
 */
export async function writePresentationFileWithoutHistory(id: string, virtualPath: string, content: string): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const realPath = await resolveVirtualFilePath(workDir, virtualPath);
  await writeFile(realPath, content, "utf-8");
}

/**
 * Confirms `virtualPath` is one of the presentation's declared slides
 * (listed in `project.json`'s `slides` array). The write path
 * (`setElementText`, below) calls this before touching the slide file
 * itself, so an edit aimed at e.g. `project.json` is rejected before any
 * read/write of it is attempted.
 *
 * Moved here from element-text.ts (#76): that module has to stay free of
 * Node built-ins, transitively, because `packages/core/src/text/` reuses
 * its `escapeXmlText` and has to load verbatim in a browser. This check
 * needs the real filesystem (`readVirtualFile`), so it belongs with the
 * rest of workspace.ts's id-to-workDir resolution instead.
 */
/**
 * Widened for T3 (ADR-0013): a virtual path may also be one of the
 * presentation's `templates` entries — a template is edited with exactly
 * the same element commands a slide is (`element insert / move / style set /
 * text set …`), the only reason this check is loosened at all. Neither list
 * is required to exist (a pre-T3 `.comot` has no `templates` field).
 */
async function assertSlidePathListed(workDir: string, virtualPath: string): Promise<ProjectJson> {
  const project = await readProjectJson(workDir);
  const slides = Array.isArray(project.slides) ? project.slides : [];
  const templates = readTemplateEntries(project);
  if (!slides.includes(virtualPath) && !templates.some((template) => template.file === virtualPath)) {
    throw new CoMotionError(`不是投影片：${virtualPath}`);
  }
  return project;
}

/** Reads and parses `project.json`, shared by every caller that needs its structure rather than its raw bytes. */
async function readProjectJson(workDir: string): Promise<ProjectJson> {
  const raw = await readVirtualFile(workDir, "project.json");
  try {
    return JSON.parse(raw) as ProjectJson;
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
}

/**
 * Sets the text content of one element on one slide, identified by their
 * virtual identifiers only (ADR-0004). This is the first write path into a
 * presentation's content — see element-text.ts's `replaceElementText` for
 * the mutation itself, which splices the target element's text in place
 * rather than parsing/re-serializing the SVG, to keep every other byte
 * identical. The mutation is a pure function that throws before any write
 * is attempted (bad element id, wrong element kind, illegal XML text), so a
 * failed `text set` never occupies an undo step.
 *
 * The font book is loaded on every call, even for a plain `<text>` element
 * that needs no measurement at all (#76, W1-R6): `replaceElementText` is
 * synchronous and has no way to fetch a book lazily only when it turns out
 * to be a text box, and the alternative — an async `replaceElementText`, or
 * two entry points — was judged uglier than the cost of one extra font
 * lookup per `text set` call.
 */
export async function setElementText(
  id: string,
  slidePath: string,
  elementId: string,
  newText: string,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  // Preserves the original check order/wording: a missing real file is
  // reported before "not a slide", exactly as writeSlideElementText did.
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const updated = replaceElementText(original, elementId, newText, { fontBook, force: options.force });
  await writePresentationFile(id, slidePath, updated);
}

export interface AddTextBoxInput {
  x: number;
  y: number;
  /** Box width in user units. Finite, > 0 — `wrapText` enforces this. */
  width: number;
  text: string;
  fontSize: number;
  fontFamily: string;
  /** Purely a rendering attribute (#98's font model has no per-weight variants) — never read for measurement. */
  fontWeight?: number;
  fill?: string;
  /**
   * Baked into every line's `x` and never revisited (NOOP-65 決定: 對齊只
   *在插入時) — no command ever changes an existing text box's alignment.
   * Omitting it (or passing `"left"`) writes no `data-comot-text-align`
   * attribute at all, so a box with no alignment opinion serializes
   * exactly as it always has.
   */
  align?: "left" | "center" | "right";
}

/**
 * Rounds `value` through the same 4-decimal rule the SVG write path uses
 * (`formatSvgNumber`) and rejects it if that rounding collapses a positive
 * input to zero (or below). `wrapText`/`assertFontSize` already reject
 * `value <= 0` outright; this catches the narrower case they cannot see —
 * a value that is positive on input but would be silently persisted as `0`,
 * producing a text box the write path itself can create but the edit path
 * (`readTextFontInfo`, `resizeTextBox`) then rejects (#76 finding, W1-R11).
 * Returns the rounded value so callers wrap against exactly what gets
 * written, keeping the declared width/size and the baked tspans in
 * agreement.
 */
function assertPositiveAfterRounding(value: number, message: string): number {
  const rounded = Number(formatSvgNumber(value));
  if (!(rounded > 0)) {
    throw new CoMotionError(message);
  }
  return rounded;
}

/**
 * Creates a new text box on a slide: a `<g>` container carrying
 * `data-comot-text-width`, appended as the last child of `<svg>`, wrapping
 * a `<text>` whose content is the wrap of `input.text` at `input.width`
 * baked into `<tspan>`s (#76, AC1/AC2 — `co-motion textbox add`).
 *
 * Does NOT call `assertSlideCompliant`: the design doc's brief claimed
 * every editing command opens with it, but that does not hold for the
 * existing write path — `setElementText`/`replaceElementText` call no such
 * check today, and the default slide `buildMinimalPresentation` writes for
 * a brand-new presentation is itself non-compliant (a bare `<text>`, not
 * wrapped in a `<g>`). Gating `textbox add` on compliance would make it
 * impossible to add a text box to a freshly created deck without running
 * `convert` first — a regression this unit is not introducing. Appending a
 * new element only needs a well-formed `<svg>` root, which `appendElementToSvg`
 * (element-text.ts) already requires by finding it via `scanDocument`.
 *
 * Ends at `writePresentationFile` like every other write path, so undo is
 * free.
 */
export async function addTextBox(
  id: string,
  slidePath: string,
  input: AddTextBoxInput,
): Promise<{ elementId: string; lines: number }> {
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new CoMotionError("文字框的座標必須是有限數字");
  }
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);

  const fonts = await resolvePresentationFonts(id);
  const font = fonts.get(input.fontFamily);
  if (!font) {
    throw new CoMotionError(`簡報未內嵌字型：${input.fontFamily}`);
  }
  // Wrap against the value that will actually be written, not the raw
  // input: `formatSvgNumber` rounds to 4 decimals, and a positive width or
  // font-size below that floor would otherwise serialize as "0" while the
  // wrap was computed against the un-rounded number — a text box whose file
  // declares a width/size the wrap never agreed to (#76 finding, W1-R11).
  // Errors over fallbacks: reject before any splice happens.
  const normalizedWidth = assertPositiveAfterRounding(input.width, "文字框寬度四捨五入後不是大於 0 的數字");
  const normalizedFontSize = assertPositiveAfterRounding(input.fontSize, "文字框的 font-size 四捨五入後不是大於 0 的數字");
  const align = input.align ?? "left";
  const wrapped = wrapText(input.text, { width: normalizedWidth, font, fontSizePx: normalizedFontSize, align });
  const content = renderTextBoxContent(wrapped.lines);

  const elementId = generateElementId();
  const weightAttr = input.fontWeight === undefined ? "" : ` font-weight="${formatSvgNumber(input.fontWeight)}"`;
  const fillAttr = input.fill === undefined ? "" : ` fill="${escapeXmlAttr(input.fill)}"`;
  const alignAttr = align === "left" ? "" : ` data-comot-text-align="${align}"`;
  const markup =
    `<g id="${elementId}" data-comot-text-width="${formatSvgNumber(normalizedWidth)}" ` +
    `data-comot-text-height="${formatSvgNumber(wrapped.height)}"${alignAttr} ` +
    `transform="translate(${formatSvgNumber(input.x)} ${formatSvgNumber(input.y)})">` +
    `<text font-family="${escapeXmlAttr(input.fontFamily)}" font-size="${formatSvgNumber(normalizedFontSize)}"` +
    `${weightAttr}${fillAttr} xml:space="preserve">${content}</text></g>`;

  const updated = appendElementToSvg(original, markup);
  await writePresentationFile(id, slidePath, updated);
  return { elementId, lines: wrapped.lines.length };
}

/**
 * Sets or clears `font-weight`/`font-style` over a character range of a
 * text box's content (NOOP-65 §4.2, `co-motion text style set`) — same
 * shape as `setTextBoxWidth` above.
 */
export async function setSlideTextRunStyle(
  id: string,
  slidePath: string,
  elementId: string,
  start: number,
  end: number,
  update: TextRunStyleUpdate,
  options: MutationOptions = {},
): Promise<{ runs: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const { updated, runs } = setTextRunStyle(original, elementId, start, end, update, fontBook, { force: options.force });
  await writePresentationFile(id, slidePath, updated);
  return { runs };
}

/**
 * Sets one paragraph's list kind (NOOP-65 §4.3, `co-motion text list set`).
 * `kind: "none"` on an already-`"none"` paragraph is a legal no-op (§4.3
 * table) — `setParagraphList` signals that by returning `svgContent`
 * completely unchanged, which this skips writing entirely so it occupies no
 * undo step, the same posture `commitTextEdit` (canvas.ts) already has for
 * an unchanged `text set`.
 */
export async function setSlideParagraphList(
  id: string,
  slidePath: string,
  elementId: string,
  paragraph: number,
  kind: ListKind,
  options: MutationOptions = {},
): Promise<{ paragraphs: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const { updated, paragraphs } = setParagraphList(original, elementId, paragraph, kind, fontBook, { force: options.force });
  if (updated !== original) {
    await writePresentationFile(id, slidePath, updated);
  }
  return { paragraphs };
}

/**
 * Re-wraps a text box's existing content at a new declared width (#76,
 * AC3's width half — `co-motion textbox width`). The text itself is
 * unchanged; only `data-comot-text-width` and the baked-in `<tspan>`s move.
 */
export async function setTextBoxWidth(
  id: string,
  slidePath: string,
  elementId: string,
  width: number,
  options: MutationOptions = {},
): Promise<{ lines: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const { updated, lines } = resizeTextBox(original, elementId, width, fontBook, { force: options.force });
  await writePresentationFile(id, slidePath, updated);
  return { lines };
}

/**
 * Re-wraps a text box against a new alignment (#200, `co-motion textbox
 * align`) — same shape as `setTextBoxWidth` above, just the other axis of
 * `rewrapTextBoxContent`.
 */
export async function setTextBoxAlign(
  id: string,
  slidePath: string,
  elementId: string,
  align: "left" | "center" | "right",
  options: MutationOptions = {},
): Promise<{ lines: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const { updated, lines } = realignTextBox(original, elementId, align, fontBook, { force: options.force });
  await writePresentationFile(id, slidePath, updated);
  return { lines };
}

/**
 * Sets a slide's Page style (#200 §4.4, `co-motion slide style set`) —
 * background/accent colour, written on the root `<svg>`'s `style`
 * attribute. Unlike `presentation canvas set`, this goes through
 * `writePresentationFile` (入歷史): the acceptance criteria's "Undo 可回退
 * （頁面尺寸除外）" names page SIZE as the one exception, not Page style.
 */
export async function setSlidePageStyle(
  id: string,
  slidePath: string,
  update: PageStyleUpdate,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = applyPageStyle(original, update);
  await writePresentationFile(id, slidePath, updated);
}

/**
 * The seven "element edit" write paths (#104): each follows the same shape
 * as `setElementText`/`addTextBox`/`setTextBoxWidth` above — resolve the
 * work directory, confirm the slide is listed, read it, call the pure
 * mutation in `element-edit.ts`, write the result back through
 * `writePresentationFile` (undo/redo therefore comes for free). Every one of
 * them locates its target(s) purely from the slide's own content and
 * `elementIds`; none of them takes a real filesystem path.
 */

export async function insertSlideElement(
  id: string,
  slidePath: string,
  input: InsertElementInput,
): Promise<{ elementId: string }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const elementId = generateElementId();
  const updated = insertElement(original, slidePath, elementId, input);
  await writePresentationFile(id, slidePath, updated);
  return { elementId };
}

export async function deleteSlideElements(id: string, slidePath: string, elementIds: string[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = deleteElements(original, slidePath, elementIds);
  await writePresentationFile(id, slidePath, updated);
}

export async function moveSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  dx: number,
  dy: number,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = moveElements(original, slidePath, elementIds, dx, dy, options);
  await writePresentationFile(id, slidePath, updated);
}

export async function rotateSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  degrees: number,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = rotateElements(original, slidePath, elementIds, degrees, options);
  await writePresentationFile(id, slidePath, updated);
}

export async function scaleSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  factor: number,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const updated = scaleElements(original, slidePath, elementIds, factor, fontBook, options);
  await writePresentationFile(id, slidePath, updated);
}

export async function resizeSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  width: number,
  height: number,
  anchor: ResizeAnchor,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const updated = resizeElements(original, slidePath, elementIds, width, height, anchor, fontBook, options);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideElementStyle(
  id: string,
  slidePath: string,
  elementIds: string[],
  attr: string,
  value: string,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const updated = setElementStyle(original, slidePath, elementIds, attr, value, fontBook, options);
  await writePresentationFile(id, slidePath, updated);
}

export async function reorderSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  direction: OrderDirection,
  options: MutationOptions = {},
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = reorderElements(original, slidePath, elementIds, direction, options);
  await writePresentationFile(id, slidePath, updated);
}

/**
 * Locks / unlocks a slide or template's elements (`co-motion element lock` /
 * `unlock`, T3, ADR-0013) — same shape as the other element-edit write
 * paths. `slidePath` may name either a listed slide or a template
 * (`assertSlidePathListed`'s widened check), since a template is edited
 * with the same commands a slide is.
 */
export async function lockSlideElements(id: string, slidePath: string, elementIds: string[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = lockElements(original, slidePath, elementIds);
  await writePresentationFile(id, slidePath, updated);
}

export async function unlockSlideElements(id: string, slidePath: string, elementIds: string[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = unlockElements(original, slidePath, elementIds);
  await writePresentationFile(id, slidePath, updated);
}

/**
 * Renders a slide's bytes for display: `{{ slide_number }}`,
 * `{{ slide_total }}` and `{{ presentation_name }}` are substituted with
 * values computed fresh from `project.json`'s current state (NOOP-90/T4).
 * `slide_number` is `project.slides.indexOf(slidePath) + 1` — recomputed on
 * every call, never cached — so any command that changes slide order makes
 * this correct automatically, with no dynamic-text-specific "reorder"
 * logic anywhere.
 *
 * This is a read path: the result is never written back through
 * `writePresentationFile`. `cat`'s byte-exact contract is unaffected —
 * only a caller that explicitly wants the rendered-for-display bytes
 * (`co-motion serve`'s `/api/files/` route for slide paths) calls this.
 */
export async function renderSlideForDisplay(id: string, slidePath: string): Promise<string> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  const project = await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const slideNumber = project.slides.indexOf(slidePath) + 1;
  const variables = new Map<string, string>([
    ["slide_number", String(slideNumber)],
    ["slide_total", String(project.slides.length)],
    ["presentation_name", escapeXmlText(project.name)],
  ]);
  return substituteDynamicText(original, variables);
}

/**
 * Writes `content` to a virtual path that must not already exist — the
 * creation counterpart to `writePresentationFile` (asset import,
 * NOOP-90/T4). Undo for a created file deletes it instead of restoring
 * prior content (`stageNewFileEntry`, history.ts), so it plugs into the
 * same `undo`/`redo` commands as every other write with no bespoke
 * asset-import undo logic.
 *
 * Binary-safe: `content` is written and later restored as raw bytes,
 * never decoded as text — unlike `writePresentationFile`, which is only
 * ever used for this codebase's own UTF-8 SVG/JSON content.
 */
export async function createPresentationFile(id: string, virtualPath: string, content: Buffer): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  let alreadyExists = true;
  try {
    await resolveVirtualFilePath(workDir, virtualPath);
  } catch (error) {
    if (!(error instanceof CoMotionNotFoundError)) {
      throw error;
    }
    alreadyExists = false;
  }
  if (alreadyExists) {
    throw new CoMotionError(`檔案已存在：${virtualPath}`);
  }

  const entries = [stageNewFileEntry(virtualPath)];
  const segments = virtualPath.split("/").filter((segment) => segment.length > 0);
  const realPath = path.join(workDir, ...segments);
  try {
    await mkdir(path.dirname(realPath), { recursive: true });
    await writeFile(realPath, content);
  } catch {
    await discardSnapshotEntries(id, entries);
    // realPath is a real filesystem path (ADR-0004) — never quote it.
    throw new CoMotionError(`寫入檔案時發生錯誤：${virtualPath}`);
  }
  const { pendingDeletionSnapshotIds } = await commitSnapshotEntries(id, entries);
  await finalizeCommittedEntries(id, pendingDeletionSnapshotIds);
}

/**
 * Deletes an existing virtual path (T3's `slide delete`). The deletion
 * counterpart to `writePresentationFile`: the file's current content is
 * snapshotted first (`stageSnapshotEntries`), so undo restores it exactly —
 * `history.ts`'s `applyGroup` already knows how to recreate a deleted file
 * (`mkdir -p` then rewrite) from a snapshot entry. A failed delete discards
 * the staged snapshot instead of committing it, same as every other write
 * path here.
 */
export async function deletePresentationFile(id: string, virtualPath: string): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const realPath = await resolveVirtualFilePath(workDir, virtualPath);
  const entries = await stageSnapshotEntries(id, [virtualPath]);
  try {
    await rm(realPath, { force: true });
  } catch {
    await discardSnapshotEntries(id, entries);
    // realPath is a real filesystem path (ADR-0004) — never quote it.
    throw new CoMotionError(`刪除檔案時發生錯誤：${virtualPath}`);
  }
  const { pendingDeletionSnapshotIds } = await commitSnapshotEntries(id, entries);
  await finalizeCommittedEntries(id, pendingDeletionSnapshotIds);
}

// ---------------------------------------------------------------------------
// element group / ungroup / align / distribute / name set / clipboard
// (NOOP-113, T6). Same shape as the "seven element edit" write paths above:
// resolve work dir, confirm the slide is listed, read, mutate, write back
// through `writePresentationFile`.
// ---------------------------------------------------------------------------

export async function groupSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
): Promise<{ elementId: string; removedEffects: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const elementId = generateElementId();
  const { svg, removedEffects } = groupElements(original, slidePath, elementIds, elementId);
  await writePresentationFile(id, slidePath, svg);
  return { elementId, removedEffects };
}

export async function ungroupSlideElements(id: string, slidePath: string, elementIds: string[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = ungroupElements(original, slidePath, elementIds);
  await writePresentationFile(id, slidePath, updated);
}

// ---------------------------------------------------------------------------
// effect add / remove / move / set / list ([E2.T7]). Same shape as the
// element-edit write paths above: resolve work dir, confirm the slide is
// listed, read, mutate (or, for `list`, just read), write back through
// `writePresentationFile` where applicable.
// ---------------------------------------------------------------------------

export async function addSlideEffects(
  id: string,
  slidePath: string,
  elementIds: string[],
  input: AddEffectInput,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = addEffects(original, slidePath, elementIds, input);
  await writePresentationFile(id, slidePath, updated);
}

export async function removeSlideEffects(id: string, slidePath: string, indices: number[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = removeEffects(original, slidePath, indices);
  await writePresentationFile(id, slidePath, updated);
}

export async function moveSlideEffect(id: string, slidePath: string, index: number, direction: "up" | "down"): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = moveEffect(original, slidePath, index, direction);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideEffect(id: string, slidePath: string, index: number, input: SetEffectInput): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setEffect(original, slidePath, index, input);
  await writePresentationFile(id, slidePath, updated);
}

export async function listSlideEffects(id: string, slidePath: string): Promise<Effect[]> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  return readEffectList(original, slidePath);
}

export async function alignSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  direction: AlignDirection,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const updated = alignElements(original, slidePath, elementIds, direction, fontBook);
  await writePresentationFile(id, slidePath, updated);
}

export async function distributeSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  axis: DistributeAxis,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await resolvePresentationFonts(id);
  const updated = distributeElements(original, slidePath, elementIds, axis, fontBook);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideElementName(
  id: string,
  slidePath: string,
  elementIds: string[],
  name: string,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setElementName(original, slidePath, elementIds, name);
  await writePresentationFile(id, slidePath, updated);
}

/** `<CO_MOTION_HOME>/clipboard/<presentationId>.json` — sibling to `history/<id>/`, outside the working directory (packing the working dir into `.comot` must never leak clipboard contents). Per-id filing is the entire mechanism enforcing "same presentation only". */
function clipboardFilePath(home: string, id: string): string {
  return path.join(home, "clipboard", `${id}.json`);
}

async function readClipboardFile(home: string, id: string): Promise<ClipboardPayload> {
  let raw: string;
  try {
    raw = await readFile(clipboardFilePath(home, id), "utf-8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new CoMotionError("剪貼簿是空的");
    }
    throw new CoMotionError("無法讀取剪貼簿");
  }
  try {
    return JSON.parse(raw) as ClipboardPayload;
  } catch {
    throw new CoMotionError("剪貼簿資料已損毀");
  }
}

async function writeClipboardFile(home: string, id: string, payload: ClipboardPayload): Promise<void> {
  const dir = path.join(home, "clipboard");
  await mkdir(dir, { recursive: true });
  await writeFile(clipboardFilePath(home, id), JSON.stringify(payload), "utf-8");
}

/** Extracts `elementIds` into the presentation's clipboard file. Never mutates the presentation — no undo step recorded. */
export async function copySlideElements(id: string, slidePath: string, elementIds: string[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const payload = extractElementsForCopy(original, slidePath, elementIds);
  await writeClipboardFile(home, id, payload);
}

/**
 * Extracts `elementIds` into the presentation's clipboard file, then deletes
 * them from the slide — `element cut` (NOOP-141). `extractElementsForCopy`
 * runs before `deleteElements` (it reads the pre-deletion content, and any
 * missing id fails the whole command before anything is mutated), and the
 * clipboard write happens before `writePresentationFile` (a failed clipboard
 * write must never leave the presentation already edited). The whole thing
 * collapses to a single `writePresentationFile` call, so it gets exactly one
 * undo step for free — no `beginHistoryGroup`/`endHistoryGroup` needed. Undo
 * restores the deleted elements but does not restore the clipboard, same as
 * every real editor.
 */
export async function cutSlideElements(id: string, slidePath: string, elementIds: string[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const payload = extractElementsForCopy(original, slidePath, elementIds);
  const updated = deleteElements(original, slidePath, elementIds);
  await writeClipboardFile(home, id, payload);
  await writePresentationFile(id, slidePath, updated);
}

/** Pastes the presentation's clipboard file into `slidePath`, which may differ from where it was copied from. */
export async function pasteSlideClipboard(
  id: string,
  slidePath: string,
  dx: number,
  dy: number,
): Promise<{ elementIds: string[] }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const payload = await readClipboardFile(home, id);
  const original = await readVirtualFile(workDir, slidePath);
  const { updated, elementIds } = pasteElements(original, slidePath, payload, dx, dy, generateElementId);
  await writePresentationFile(id, slidePath, updated);
  return { elementIds };
}

/**
 * Copies `elementIds` and pastes them back onto the same slide in one step
 * (決定 7) — internally the same extract/paste pair `copy`/`paste` use, but
 * routed around the clipboard file entirely so it never overwrites the
 * user's actual clipboard.
 */
export async function duplicateSlideElements(
  id: string,
  slidePath: string,
  elementIds: string[],
  dx: number,
  dy: number,
): Promise<{ elementIds: string[] }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const payload = extractElementsForCopy(original, slidePath, elementIds);
  const { updated, elementIds: newIds } = pasteElements(original, slidePath, payload, dx, dy, generateElementId);
  await writePresentationFile(id, slidePath, updated);
  return { elementIds: newIds };
}

// ---------------------------------------------------------------------------
// table (E2.T14) — same six-line shape as every other write path above:
// resolve -> assert listed -> read -> pure core function -> write. `table
// bind`/`table refresh`/`table set --from`'s CSV source is resolved to a
// plain `ParsedTableCsv` HERE, the one place in the stack allowed to touch
// the real filesystem (`readFile`) or a deck's virtual one
// (`readVirtualFile`) — `table/edit.ts` itself only ever sees already-parsed
// data.
// ---------------------------------------------------------------------------

export async function createSlideTable(
  id: string,
  slidePath: string,
  input: CreateTableInput,
): Promise<{ elementId: string }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const elementId = generateElementId();
  const updated = createTableElement(original, slidePath, elementId, input, fonts);
  await writePresentationFile(id, slidePath, updated);
  return { elementId };
}

export async function setSlideTableCellText(
  id: string,
  slidePath: string,
  elementId: string,
  row: number,
  col: number,
  text: string,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = setTableCellText(original, slidePath, elementId, row, col, text, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export interface SetSlideTableCellStyleInput {
  row: number;
  col: number;
  rowEnd?: number;
  colEnd?: number;
  attr: CellStyleAttr;
  value: string;
}

export async function setSlideTableCellStyle(
  id: string,
  slidePath: string,
  elementId: string,
  input: SetSlideTableCellStyleInput,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = setTableCellStyle(original, slidePath, elementId, input, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export interface MergeSlideTableCellsInput {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  unmerge?: boolean;
}

export async function mergeSlideTableCells(
  id: string,
  slidePath: string,
  elementId: string,
  input: MergeSlideTableCellsInput,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = mergeTableCells(original, slidePath, elementId, input, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideTableColWidth(
  id: string,
  slidePath: string,
  elementId: string,
  col: number,
  width: number,
  keepTotal = false,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = setTableColWidth(original, slidePath, elementId, col, width, fonts, keepTotal);
  await writePresentationFile(id, slidePath, updated);
}

export async function insertSlideTableColumn(id: string, slidePath: string, elementId: string, at: number): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = insertTableColumn(original, slidePath, elementId, at, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function deleteSlideTableColumn(id: string, slidePath: string, elementId: string, at: number): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = deleteTableColumn(original, slidePath, elementId, at, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function insertSlideTableRow(id: string, slidePath: string, elementId: string, at: number): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = insertTableRow(original, slidePath, elementId, at, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function deleteSlideTableRow(id: string, slidePath: string, elementId: string, at: number): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = deleteTableRow(original, slidePath, elementId, at, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideTableTheme(id: string, slidePath: string, elementId: string, theme: TableTheme): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = setTableTheme(original, slidePath, elementId, theme, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideTableHeader(id: string, slidePath: string, elementId: string, header: boolean): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);
  const updated = setTableHeader(original, slidePath, elementId, header, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function bindSlideTableSource(
  id: string,
  slidePath: string,
  elementId: string,
  source: string,
  templateRow: number | undefined,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const csvText = await readVirtualFile(workDir, source);
  const csv = parseTableCsv(csvText);
  const fonts = await resolvePresentationFonts(id);
  const updated = bindTableSource(original, slidePath, elementId, source, templateRow, csv, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export async function refreshSlideTableSource(id: string, slidePath: string, elementId: string): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const currentModel = readTableModel(original, elementId);
  if (currentModel.source === null) {
    throw new CoMotionError(`表格 ${elementId} 沒有資料來源`);
  }
  const csvText = await readVirtualFile(workDir, currentModel.source);
  const csv = parseTableCsv(csvText);
  const fonts = await resolvePresentationFonts(id);
  const updated = refreshTableSource(original, slidePath, elementId, csv, fonts);
  await writePresentationFile(id, slidePath, updated);
}

export interface SetSlideTableInput {
  /** A virtual path inside the presentation, e.g. `assets/data/sales.csv`. */
  from?: string;
  /** Literal markdown table text. */
  markdown?: string;
  /** A local filesystem path outside the presentation, read as markdown table text. */
  markdownFile?: string;
}

export async function setSlideTable(
  id: string,
  slidePath: string,
  elementId: string,
  input: SetSlideTableInput,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fonts = await resolvePresentationFonts(id);

  if (input.from !== undefined) {
    const csvText = await readVirtualFile(workDir, input.from);
    const csv = parseTableCsv(csvText);
    const updated = setTableFromCsv(original, slidePath, elementId, csv, fonts);
    await writePresentationFile(id, slidePath, updated);
    return;
  }
  if (input.markdown !== undefined || input.markdownFile !== undefined) {
    let markdownText: string;
    if (input.markdownFile !== undefined) {
      try {
        markdownText = await readFile(input.markdownFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new CoMotionNotFoundError(`找不到 Markdown 檔案：${input.markdownFile}`);
        }
        throw error;
      }
    } else {
      markdownText = input.markdown!;
    }
    const markdown = parseMarkdownTable(markdownText);
    const updated = setTableFromMarkdown(original, slidePath, elementId, markdown, fonts);
    await writePresentationFile(id, slidePath, updated);
    return;
  }
  throw new CoMotionError("table set 必須提供 --from、--markdown 或 --markdown-file 其中一種");
}

// ---------------------------------------------------------------------------
// chart (E2.T12) — same six-line shape as every other write path above:
// resolve -> assert listed -> read -> pure core function -> write. `chart
// data set`'s three data sources (`--categories`/`--series`, `--csv`,
// `--csv-asset`) are resolved to a plain `{categories, series}` HERE, the
// one place in the stack that is allowed to touch the real filesystem
// (`readFile`) or a deck's virtual one (`readVirtualFile`) — `chart/edit.ts`
// itself only ever sees already-parsed data.
// ---------------------------------------------------------------------------

export async function createSlideChart(
  id: string,
  slidePath: string,
  input: CreateChartInput,
): Promise<{ elementId: string }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const elementId = generateElementId();
  const updated = createChartElement(original, slidePath, elementId, input);
  await writePresentationFile(id, slidePath, updated);
  return { elementId };
}

export interface SetSlideChartDataInput {
  categories?: string[];
  series?: { name: string; values: number[] }[];
  /** A local filesystem path outside the presentation. */
  csv?: string;
  /** A virtual path INSIDE the presentation (e.g. `assets/data/quarterly.csv`). */
  csvAsset?: string;
}

export async function setSlideChartData(
  id: string,
  slidePath: string,
  elementId: string,
  input: SetSlideChartDataInput,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);

  let categories: string[];
  let series: { name: string; values: number[] }[];
  if (input.csv !== undefined) {
    let text: string;
    try {
      text = await readFile(input.csv, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CoMotionNotFoundError(`找不到 CSV 檔案：${input.csv}`);
      }
      throw error;
    }
    ({ categories, series } = parseChartCsv(text));
  } else if (input.csvAsset !== undefined) {
    const text = await readVirtualFile(workDir, input.csvAsset);
    ({ categories, series } = parseChartCsv(text));
  } else {
    if (input.categories === undefined || input.series === undefined) {
      throw new CoMotionError("chart data set 必須提供 --categories/--series、--csv 或 --csv-asset 其中一種");
    }
    categories = input.categories;
    series = input.series;
  }

  const updated = setChartData(original, slidePath, elementId, { categories, series });
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideChartType(
  id: string,
  slidePath: string,
  elementId: string,
  type: ChartType,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setChartType(original, slidePath, elementId, type);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideChartPalette(
  id: string,
  slidePath: string,
  elementId: string,
  palette: ChartPalette,
  colorOverrides: ReadonlyMap<string, string>,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setChartPalette(original, slidePath, elementId, palette, colorOverrides);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideChartAxis(
  id: string,
  slidePath: string,
  elementId: string,
  axes: ChartAxesMode,
  rightSeriesNames: readonly string[],
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setChartAxis(original, slidePath, elementId, axes, rightSeriesNames);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideChartStack(
  id: string,
  slidePath: string,
  elementId: string,
  stacked: boolean,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setChartStack(original, slidePath, elementId, stacked);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideChartLegend(
  id: string,
  slidePath: string,
  elementId: string,
  legend: ChartLegend,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setChartLegend(original, slidePath, elementId, legend);
  await writePresentationFile(id, slidePath, updated);
}

export async function setSlideChartOption(
  id: string,
  slidePath: string,
  elementId: string,
  key: ChartOptionKey,
  value: string,
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const updated = setChartOption(original, slidePath, elementId, key, value);
  await writePresentationFile(id, slidePath, updated);
}
