import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError, CoMotionNotFoundError } from "./errors.js";
import { generateElementId, generateOpaqueId } from "./id.js";
import { buildMinimalPresentation, type ProjectJson } from "./presentation.js";
import { packDirectory, unpackContainer } from "./container.js";
import { listVirtualEntries, readVirtualFile, readVirtualFileBytes, resolveVirtualFilePath } from "./virtual-fs.js";
import {
  appendElementToSvg,
  escapeXmlAttr,
  escapeXmlText,
  replaceElementText,
  resizeTextBox,
  substituteDynamicText,
} from "./element-text.js";
import {
  deleteElements,
  insertElement,
  lockElements,
  moveElements,
  reorderElements,
  rotateElements,
  scaleElements,
  setElementStyle,
  unlockElements,
  type InsertElementInput,
  type MutationOptions,
  type OrderDirection,
} from "./element-edit.js";
import { commitSnapshotEntries, discardSnapshotEntries, stageNewFileEntry, stageSnapshotEntries } from "./history.js";
import { resolvePresentationFonts } from "./fonts.js";
import { wrapText } from "./text/wrap.js";
import { renderTextBoxContent } from "./text/render.js";
import { formatSvgNumber } from "./svg-number.js";
import { groupElements, setElementName, ungroupElements } from "./element-group.js";
import { alignElements, distributeElements, type AlignDirection, type DistributeAxis } from "./element-arrange.js";
import { extractElementsForCopy, pasteElements, type ClipboardPayload } from "./element-clipboard.js";

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
  const templates = Array.isArray(project.templates) ? project.templates : [];
  if (!slides.includes(virtualPath) && !templates.includes(virtualPath)) {
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
  const wrapped = wrapText(input.text, { width: normalizedWidth, font, fontSizePx: normalizedFontSize });
  const content = renderTextBoxContent(wrapped.lines);

  const elementId = generateElementId();
  const weightAttr = input.fontWeight === undefined ? "" : ` font-weight="${formatSvgNumber(input.fontWeight)}"`;
  const fillAttr = input.fill === undefined ? "" : ` fill="${escapeXmlAttr(input.fill)}"`;
  const markup =
    `<g id="${elementId}" data-comot-text-width="${formatSvgNumber(normalizedWidth)}" ` +
    `transform="translate(${formatSvgNumber(input.x)} ${formatSvgNumber(input.y)})">` +
    `<text font-family="${escapeXmlAttr(input.fontFamily)}" font-size="${formatSvgNumber(normalizedFontSize)}"` +
    `${weightAttr}${fillAttr} xml:space="preserve">${content}</text></g>`;

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
  await commitSnapshotEntries(id, entries);
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
  await commitSnapshotEntries(id, entries);
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
): Promise<{ elementId: string }> {
  const home = resolveCoMotionHome();
  const workDir = await lookupWorkDir(home, id);
  await resolveVirtualFilePath(workDir, slidePath);
  await assertSlidePathListed(workDir, slidePath);
  const original = await readVirtualFile(workDir, slidePath);
  const elementId = generateElementId();
  const updated = groupElements(original, slidePath, elementIds, elementId);
  await writePresentationFile(id, slidePath, updated);
  return { elementId };
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
  const updated = alignElements(original, slidePath, elementIds, direction);
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
  const updated = distributeElements(original, slidePath, elementIds, axis);
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
