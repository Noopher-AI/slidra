import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError, CoMotionNotFoundError } from "./errors.js";
import { generateElementId, generateOpaqueId } from "./id.js";
import { buildMinimalPresentation, type ProjectJson } from "./presentation.js";
import { packDirectory, unpackContainer } from "./container.js";
import { listVirtualEntries, readVirtualFile, readVirtualFileBytes, resolveVirtualFilePath } from "./virtual-fs.js";
import { appendElementToSvg, escapeXmlAttr, replaceElementText, resizeTextBox } from "./element-text.js";
import { commitSnapshotEntries, discardSnapshotEntries, stageSnapshotEntries } from "./history.js";
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
