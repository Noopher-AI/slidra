import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError, CoMotionHistoryCleanupError, CoMotionNotFoundError } from "./errors.js";
import { generateElementId, generateOpaqueId } from "./id.js";
import { buildMinimalPresentation, type ProjectJson } from "./presentation.js";
import { validateProjectJson } from "./project-json.js";
import { packDirectory, unpackContainer } from "./container.js";
import {
  deleteVirtualFile,
  listVirtualEntries,
  readVirtualFile,
  readVirtualFileBytes,
  resolveNewVirtualFilePath,
  resolveVirtualFilePath,
} from "./virtual-fs.js";
import { appendElementToSvg, escapeXmlAttr, replaceElementText, resizeTextBox } from "./element-text.js";
import { commitSnapshotEntries, discardSnapshotEntries, readSnapshotContent, stageSnapshotEntries } from "./history.js";
import { ensureBundledFonts, loadFontBook } from "./font/bundle.js";
import { MEASURED_TEXT_CSS, type FontBook, type TextStyle } from "./font/metrics.js";
import { wrapText } from "./text/wrap.js";
import { renderTextBoxContent } from "./text/render.js";
import { formatSvgNumber } from "./geometry/transform.js";
import {
  assertPositiveAfterRounding,
  buildShapeMarkup,
  removeElements,
  type AddShapeInput,
} from "./slide/edit.js";
import {
  buildBlankSlideSvg,
  insertSlidePathAt,
  moveSlidePath,
  nextSlideFileName,
  removeSlidePath,
} from "./slide/order.js";

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
  // A presentation that is about to leave this machine must carry its font
  // (#71 acceptance 1): the `.comot` has to open without depending on any
  // font being installed. Acquiring it here rather than in
  // `createNewPresentation` keeps an empty new deck empty, and a deck that
  // already has its font is not fetched again.
  await ensureBundledFonts(workDir);
  await packDirectory(workDir, outputPath);
}

/**
 * The font book of the presentation identified by `id` — the only way a
 * command layer gets at text measurement (ADR-0004: ids, never paths).
 *
 * This is the other point at which a presentation first genuinely needs a
 * font, so it is also where it acquires one. The font is written into the
 * work directory, so the next measurement and the next `pack` both find it
 * already there and nothing is fetched twice.
 */
export async function readPresentationFontBook(id: string): Promise<FontBook> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await ensureBundledFonts(workDir);
  return loadFontBook(workDir);
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
 * The snapshot is *staged* (its file written) before the content write, but
 * only *committed* onto the undo/redo stacks (history.ts's
 * `commitSnapshotEntries`) after that write actually succeeds. If the
 * write fails, the staged snapshot is discarded instead
 * (`discardSnapshotEntries`) — a failed command must not occupy an undo
 * slot, and it must not leave an orphan snapshot file either (finding 2).
 */
export async function writePresentationFile(id: string, virtualPath: string, content: string): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const realPath = await resolveVirtualFilePath(workDir, virtualPath);
  const entries = await stageSnapshotEntries(id, [virtualPath]);
  try {
    await writeFile(realPath, content, "utf-8");
  } catch {
    await discardSnapshotEntries(id, entries);
    // realPath is a real filesystem path (ADR-0004) — never quote it.
    throw new CoMotionError(`寫入投影片時發生錯誤：${virtualPath}`);
  }
  await commitSnapshotEntries(id, entries);
}

export interface PresentationChange {
  virtualPath: string;
  /** `null` deletes the file at `virtualPath`. */
  content: string | null;
}

/**
 * The N-file door (#85): `writePresentationFile`'s single-file shape
 * generalised so `slide add` / `slide delete` / `slide duplicate` — each of
 * which must create or remove a slide file *and* rewrite `project.json`,
 * yet undo as exactly one step — can do so without `beginHistoryGroup`
 * (forbidden, W3-R10: it throws on nesting and #91 needs the whole-turn
 * group). `stageSnapshotEntries` already stages an array; one
 * `commitSnapshotEntries` over that whole array turns however many files
 * changed into exactly one undo group. `writePresentationFile` stays a
 * one-element wrapper — untouched — so every existing write path is
 * unaffected.
 *
 * Partial-failure ordering (W3-R9) is the CALLER's responsibility, not
 * this function's: pass the slide-file change first and the `project.json`
 * change last for create/duplicate, and `project.json` first and the file
 * deletion last for delete, so `project.json` is always the transition
 * point — whichever side of it fails, the deck stays internally consistent
 * (only an unreferenced file may be left on disk, never a `project.json`
 * that names a file that isn't there).
 *
 * If the very first change fails, nothing durable has happened yet: the
 * staged snapshots are discarded and this throws the same
 * `寫入投影片時發生錯誤：<virtualPath>` wording `writePresentationFile`
 * uses. If a LATER change fails after at least one earlier change already
 * landed on disk for real, that earlier write cannot be rolled back by
 * discarding snapshots (they were never applied yet) — this is the
 * leftover-unreferenced-file case W3-R9 requires to fail loudly, so it
 * throws a distinct error naming exactly which virtual paths were applied
 * before the failure, never a silent partial success.
 *
 * A separate failure mode (round-1 gate finding, W3-R11): every change can
 * apply cleanly to the filesystem and `commitSnapshotEntries` can still
 * throw (e.g. `stack.json` unwritable) — at that point real files are
 * already on disk with nothing recorded to undo them. This function
 * compensates: it restores every applied change from its already-staged
 * `HistoryEntry`, in reverse order — writing back the pre-change snapshot
 * content when one exists, or deleting the file when the staged entry's
 * `snapshotId` is `null` (meaning this change *created* that file) —
 * before discarding the staged snapshots and throwing. If the compensation
 * itself fails for some path, that path is named in the thrown error
 * instead of being silently left inconsistent (W3-R7).
 *
 * That compensation is only ever correct BEFORE `stack.json` is written
 * (round-2 gate finding, W3-R12). `commitSnapshotEntries` writes the new
 * stack durably and only then unlinks obsolete snapshot files, so a
 * failure in that cleanup means the commit succeeded; it is reported as
 * `CoMotionHistoryCleanupError` and this function returns normally,
 * leaving the deck, the undo timeline and the staged snapshots the stack
 * now references exactly as they are.
 */
export async function applyPresentationChanges(id: string, changes: PresentationChange[]): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const entries = await stageSnapshotEntries(
    id,
    changes.map((change) => change.virtualPath),
  );

  const appliedPaths: string[] = [];
  for (const change of changes) {
    try {
      if (change.content === null) {
        await deleteVirtualFile(workDir, change.virtualPath);
      } else {
        const realPath = await resolveNewVirtualFilePath(workDir, change.virtualPath);
        await writeFile(realPath, change.content, "utf-8");
      }
    } catch {
      await discardSnapshotEntries(id, entries);
      if (appliedPaths.length > 0) {
        // W3-R13: name the change that FAILED first — that is the file
        // left behind. For a delete (project.json first, file removal
        // last) the failing path is the orphan still on disk; for a
        // create (slide file first, project.json last) the orphan is the
        // already-applied slide file. Naming both roles covers both
        // orderings, and neither is ever a real filesystem path
        // (ADR-0004).
        throw new CoMotionError(
          `寫入投影片時發生部分失敗：${change.virtualPath} 未完成，已變更 ${appliedPaths.join("、")}，磁碟上可能殘留未被引用的檔案`,
        );
      }
      // Only the virtual path is ever named (ADR-0004) — never a real
      // filesystem path.
      throw new CoMotionError(`寫入投影片時發生錯誤：${change.virtualPath}`);
    }
    appliedPaths.push(change.virtualPath);
  }

  try {
    await commitSnapshotEntries(id, entries);
  } catch (error) {
    // W3-R12: the new stack.json is already durable and only the
    // obsolete-snapshot cleanup failed. The commit SUCCEEDED — the
    // persisted stack references the snapshots staged above, so
    // compensating here would revert a change the history says happened
    // and discard snapshots the stack still points at, breaking undo for
    // good. Nothing is left inconsistent for the author: the deck, the
    // undo timeline and redo all match. The only residue is one
    // unreferenced snapshot file, which is disk garbage, not a failed
    // operation — so the operation is reported as the success it is.
    if (error instanceof CoMotionHistoryCleanupError) {
      return;
    }
    const unrestoredPaths: string[] = [];
    // Reverse order: undo the applied changes last-to-first, mirroring how
    // an undo group would replay them.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      try {
        if (entry.snapshotId === null) {
          // This change created the file — compensating means removing it.
          await deleteVirtualFile(workDir, entry.virtualPath);
        } else {
          const content = await readSnapshotContent(id, entry.snapshotId);
          const realPath = await resolveNewVirtualFilePath(workDir, entry.virtualPath);
          await writeFile(realPath, content, "utf-8");
        }
      } catch {
        unrestoredPaths.push(entry.virtualPath);
      }
    }
    await discardSnapshotEntries(id, entries);
    if (unrestoredPaths.length > 0) {
      throw new CoMotionError(
        `寫入復原歷史失敗，且下列項目無法還原，與 project.json 可能不同步：${unrestoredPaths.join("、")}`,
      );
    }
    throw new CoMotionError("寫入復原歷史失敗，變更已還原");
  }
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
async function assertSlidePathListed(workDir: string, virtualPath: string): Promise<void> {
  const raw = await readVirtualFile(workDir, "project.json");
  let project: ProjectJson;
  try {
    project = JSON.parse(raw) as ProjectJson;
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  if (!Array.isArray(project.slides) || !project.slides.includes(virtualPath)) {
    throw new CoMotionError(`不是投影片：${virtualPath}`);
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
): Promise<void> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  // Preserves the original check order/wording: a missing real file is
  // reported before "not a slide", exactly as writeSlideElementText did.
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await readPresentationFontBook(id);
  const updated = replaceElementText(original, elementId, newText, { fontBook });
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
  fontWeight?: number;
  fill?: string;
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

  const book = await readPresentationFontBook(id);
  // Wrap against the value that will actually be written, not the raw
  // input: `formatSvgNumber` rounds to 4 decimals, and a positive width or
  // font-size below that floor would otherwise serialize as "0" while the
  // wrap was computed against the un-rounded number — a text box whose file
  // declares a width/size the wrap never agreed to (#76 finding, W1-R11).
  // Errors over fallbacks: reject before any splice happens.
  const normalizedWidth = assertPositiveAfterRounding(input.width, "文字框寬度四捨五入後不是大於 0 的數字");
  const normalizedFontSize = assertPositiveAfterRounding(input.fontSize, "文字框的 font-size 四捨五入後不是大於 0 的數字");
  const style: TextStyle = { fontFamily: input.fontFamily, fontSize: normalizedFontSize, fontWeight: input.fontWeight };
  const wrapped = wrapText(input.text, { width: normalizedWidth, style, book });
  const content = renderTextBoxContent(wrapped.lines);

  const elementId = generateElementId();
  const weightAttr = input.fontWeight === undefined ? "" : ` font-weight="${formatSvgNumber(input.fontWeight)}"`;
  const fillAttr = input.fill === undefined ? "" : ` fill="${escapeXmlAttr(input.fill)}"`;
  const markup =
    `<g id="${elementId}" data-comot-text-width="${formatSvgNumber(normalizedWidth)}" ` +
    `transform="translate(${formatSvgNumber(input.x)} ${formatSvgNumber(input.y)})">` +
    `<text font-family="${escapeXmlAttr(input.fontFamily)}" font-size="${formatSvgNumber(normalizedFontSize)}"` +
    `${weightAttr}${fillAttr} xml:space="preserve" style="${MEASURED_TEXT_CSS}">${content}</text></g>`;

  const updated = appendElementToSvg(original, markup);
  await writePresentationFile(id, slidePath, updated);
  return { elementId, lines: wrapped.lines.length };
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
): Promise<{ lines: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const fontBook = await readPresentationFontBook(id);
  const { updated, lines } = resizeTextBox(original, elementId, width, fontBook);
  await writePresentationFile(id, slidePath, updated);
  return { lines };
}

export type { AddShapeInput };

/**
 * Creates a new primitive shape on a slide (#74, `rect add` / `ellipse add`
 * / `line add` / `path add`): a `<g>` container carrying the id and
 * position, wrapping the requested primitive, appended as the last child of
 * `<svg>` — last child means topmost in paint order (wave 2 R8). Follows
 * `addTextBox`'s shape exactly: `buildShapeMarkup` validates and builds the
 * markup BEFORE any disk access, so a bad input never touches the
 * filesystem at all; `appendElementToSvg` splices it in without
 * re-serializing the document; `writePresentationFile` ends the write so
 * undo is free.
 *
 * Does NOT call `assertSlideCompliant`, for the same reason `addTextBox`
 * does not (see that function's doc comment): no editing command in this
 * codebase gates on it today, and `buildMinimalPresentation`'s own slide 2
 * is non-compliant by construction, so such a gate would make a freshly
 * created deck impossible to add a shape to.
 */
export async function addShape(
  id: string,
  slidePath: string,
  input: AddShapeInput,
): Promise<{ elementId: string }> {
  const elementId = generateElementId();
  const markup = buildShapeMarkup(elementId, input);

  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);

  const updated = appendElementToSvg(original, markup);
  await writePresentationFile(id, slidePath, updated);
  return { elementId };
}

/**
 * Deletes one or more elements from a slide in a single write (#74,
 * `element delete`): `removeElements` (slide/edit.ts) locates every
 * requested id, removes each subtree along with every effect entry
 * targeting it or one of its descendants, and throws before any splice if
 * an id is missing or a delete would empty a parent group. Exactly one
 * `writePresentationFile` call, however many ids are named — one file write
 * is one undo snapshot entry is one undo group (history.ts), so N elements
 * deleted together cost exactly one `undo` press. No `beginHistoryGroup` is
 * used or needed (issue #91 will wrap an agent's turn in one, and that call
 * throws on nesting).
 */
export async function deleteElements(
  id: string,
  slidePath: string,
  elementIds: readonly string[],
): Promise<{ deleted: string[]; clearedEffects: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);

  const { updated, removedIds, removedEffects } = removeElements(original, elementIds);
  await writePresentationFile(id, slidePath, updated);
  return { deleted: removedIds, clearedEffects: removedEffects };
}

/**
 * Reads and validates `project.json` (#85). The wording on a malformed file
 * — "簡報設定檔已損毀" — matches `assertSlidePathListed`'s own JSON.parse
 * failure below, so both call sites report the exact same problem the
 * exact same way.
 */
async function readProject(workDir: string): Promise<ProjectJson> {
  const raw = await readVirtualFile(workDir, "project.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  return validateProjectJson(parsed);
}

/**
 * Byte-identical to what `buildMinimalPresentation` writes for a fresh
 * deck. Mutating the already-validated object (rather than building a new
 * one from scratch) preserves any unknown forward-compat field
 * `project-json.ts`'s validator deliberately leaves on it.
 */
function serialiseProject(project: ProjectJson): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/**
 * None of the four slide operations below calls `assertSlideCompliant` or
 * `parseSlide` — same reasoning `addTextBox`/`addShape` document for
 * themselves: `buildMinimalPresentation`'s own `slides/001.svg` is a bare
 * `<text>`, so gating on compliance would make a freshly created deck
 * un-editable. `slide duplicate` in particular never parses the source
 * file at all — it copies bytes — which is also why it is not an
 * effect-list writer (W3-R9): whatever `<comot:effects>` subtree the
 * source has rides along unexamined.
 */

export interface AddSlideOptions {
  /** 1-based position for the new slide; default is one past the last slide. */
  at?: number;
}

/**
 * `co-motion slide add` (#85, AC1): allocates the next free `slides/NNN.svg`
 * name (from the directory's actual files, so an orphan left behind by an
 * undone add is never reused), writes a blank compliant slide there, and
 * inserts its path into `project.json`'s `slides` at `options.at` (default:
 * last). One `applyPresentationChanges` call — slide file first,
 * `project.json` last (W3-R9) — so the write is one undo step.
 */
export async function addSlide(id: string, options?: AddSlideOptions): Promise<{ slidePath: string; index: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const project = await readProject(workDir);

  const existingNames = await listVirtualEntries(workDir, "slides");
  const slidePath = `slides/${nextSlideFileName(existingNames)}`;
  const at = options?.at ?? project.slides.length + 1;
  const updatedSlides = insertSlidePathAt(project.slides, slidePath, at);

  const svg = buildBlankSlideSvg(project.canvas);
  const updatedProject: ProjectJson = { ...project, slides: updatedSlides };

  await applyPresentationChanges(id, [
    { virtualPath: slidePath, content: svg },
    { virtualPath: "project.json", content: serialiseProject(updatedProject) },
  ]);

  return { slidePath, index: at };
}

/**
 * `co-motion slide delete` (#85, AC1): removes `slidePath` from
 * `project.json`'s `slides` and deletes the real file. `project.json`
 * first, file deletion last (W3-R9) — a partial failure never leaves
 * `project.json` naming a file that is not there. Deleting the deck's last
 * remaining slide is refused (`removeSlidePath`) rather than allowed to
 * create an unopenable deck (`serve.ts` refuses to serve zero slides).
 */
export async function deleteSlide(id: string, slidePath: string): Promise<{ slidePath: string; remaining: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const project = await readProject(workDir);

  const updatedSlides = removeSlidePath(project.slides, slidePath);
  const updatedProject: ProjectJson = { ...project, slides: updatedSlides };

  await applyPresentationChanges(id, [
    { virtualPath: "project.json", content: serialiseProject(updatedProject) },
    { virtualPath: slidePath, content: null },
  ]);

  return { slidePath, remaining: updatedSlides.length };
}

/**
 * Asserts `slidePath` is listed in `slides` exactly once — the same
 * "not found" / "corrupt duplicate" split `slide/order.ts`'s
 * `removeSlidePath`/`moveSlidePath` enforce internally, needed here too
 * because `duplicateSlide` neither removes nor moves anything (it has no
 * `slide/order.ts` function of its own to lean on for this check).
 */
function assertSlideListedOnce(slides: readonly string[], slidePath: string): void {
  const occurrences = slides.filter((entry) => entry === slidePath).length;
  if (occurrences === 0) {
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }
  if (occurrences > 1) {
    throw new CoMotionError(`簡報設定檔的投影片順序重複：${slidePath}`);
  }
}

/**
 * `co-motion slide duplicate` (#85, AC3): copies the source slide's bytes
 * verbatim into a newly allocated `slides/NNN.svg`, inserted immediately
 * after the source in `project.json`'s `slides`. A byte-for-byte copy
 * means whatever `<comot:effects>` subtree the source carries rides along
 * for free, in whatever scope the source used — this function never
 * parses the slide, so it never becomes an effect-list writer (W3-R9) and
 * both existing effect readers see the copy exactly as they saw the
 * original (§1.0b of the design). Slide file first, `project.json` last
 * (W3-R9), same ordering as `addSlide`.
 */
export async function duplicateSlide(id: string, slidePath: string): Promise<{ slidePath: string; index: number }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const project = await readProject(workDir);
  assertSlideListedOnce(project.slides, slidePath);

  const sourceContent = await readVirtualFile(workDir, slidePath);
  const existingNames = await listVirtualEntries(workDir, "slides");
  const newSlidePath = `slides/${nextSlideFileName(existingNames)}`;

  const sourceIndex = project.slides.indexOf(slidePath); // 0-based
  const newIndex = sourceIndex + 2; // 1-based position immediately after the source
  const updatedSlides = insertSlidePathAt(project.slides, newSlidePath, newIndex);
  const updatedProject: ProjectJson = { ...project, slides: updatedSlides };

  await applyPresentationChanges(id, [
    { virtualPath: newSlidePath, content: sourceContent },
    { virtualPath: "project.json", content: serialiseProject(updatedProject) },
  ]);

  return { slidePath: newSlidePath, index: newIndex };
}

/**
 * `co-motion slide move` (#85, AC2 amended — R1: dragging the thumbnail
 * rail is out of scope, this command is what drag would eventually call):
 * rewrites `project.json`'s `slides` order only. No slide file is ever
 * read, written, `stat`ed, or opened — reorder is a one-array, one-file
 * operation (design §1.0a), which is the whole of AC4's byte-level
 * guarantee. `--to` equal to the slide's current 1-based position writes
 * nothing and pushes no undo group (`changed: false`) rather than landing
 * an undo step that visibly does nothing.
 */
export async function moveSlide(
  id: string,
  slidePath: string,
  to: number,
): Promise<{ from: number; to: number; changed: boolean }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  const project = await readProject(workDir);

  const from = project.slides.indexOf(slidePath) + 1; // 1-based; 0 only if moveSlidePath is about to throw
  const updatedSlides = moveSlidePath(project.slides, slidePath, to);
  const changed = updatedSlides.some((entry, index) => entry !== project.slides[index]);
  if (!changed) {
    return { from, to, changed: false };
  }

  const updatedProject: ProjectJson = { ...project, slides: updatedSlides };
  await applyPresentationChanges(id, [{ virtualPath: "project.json", content: serialiseProject(updatedProject) }]);

  return { from, to, changed: true };
}
