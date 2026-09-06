import { CoMotionError, CoMotionNotFoundError } from "./errors.js";
import { generateElementId, generateOpaqueId } from "./id.js";
import { validateProjectJson, readTemplateEntries, type ProjectJson, type TemplateEntry } from "./project-json.js";
import { FORMAT_VERSION } from "./presentation.js";
import { scanDocument, attributeOf, type ScannedNode } from "./slide/scan.js";
import { setSlideNotes } from "./notes.js";
import {
  addSlideComment,
  deleteSlideComment,
  editSlideComment,
  readSlideComments,
  type SlideComment,
} from "./slide/comments.js";
import { assertSlideCompliant, parseSlide, type SlideElement } from "./slide/format.js";
import {
  createPresentationFile,
  deletePresentationFile,
  listPresentationEntries,
  readPresentationFile,
  writePresentationFile,
} from "./workspace.js";
import { beginHistoryGroup, endHistoryGroup } from "./history.js";

/**
 * Slide- and template-level file orchestration (T3): `slide add / delete /
 * duplicate / move`, `template add`, `slide notes set`, and
 * `presentation transition set`. Every write here goes through
 * `writePresentationFile` / `createPresentationFile` / `deletePresentationFile`
 * (workspace.ts) — undo is free the same way it is for every element edit.
 * A multi-file operation (`slide add`/`delete`/`duplicate`/`template add`,
 * each of which touches both a slide/template file and `project.json`)
 * wraps both writes in one `beginHistoryGroup`/`endHistoryGroup` so undo
 * restores them together (ADR: multi-file one-step undo, history.ts).
 */

interface Splice {
  start: number;
  end: number;
  text: string;
}

function applySplices(svg: string, splices: readonly Splice[]): string {
  let result = svg;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

/** Reads and structurally validates `project.json` — the one entry point every function below reads the presentation's shape through. */
async function readProject(id: string): Promise<ProjectJson> {
  const raw = await readPresentationFile(id, "project.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  return validateProjectJson(parsed);
}

/**
 * The one `project.json` write point (every command below routes through
 * it). Upgrades opportunistically on every write, never on open (4.2 of
 * the plan): `formatVersion` is bumped to the current `FORMAT_VERSION`, and
 * a present `templates` field is normalized to the object-entry shape
 * (`readTemplateEntries`) — a pre-[E4.T7] file's bare-string entries become
 * `{ file, name }` the next time anything touches its `project.json`, and
 * not a moment sooner.
 */
async function writeProject(id: string, project: ProjectJson): Promise<void> {
  const nextProject: ProjectJson = { ...project, formatVersion: FORMAT_VERSION };
  if (nextProject.templates !== undefined) {
    nextProject.templates = readTemplateEntries(project);
  }
  await writePresentationFile(id, "project.json", `${JSON.stringify(nextProject, null, 2)}\n`);
}

/** Builds a blank slide/template: an empty, compliant `<svg viewBox>` with no elements yet. */
export function buildBlankSlideSvg(canvas: { width: number; height: number }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}"></svg>\n`;
}

/**
 * Re-mints every `id` in the document (決定 6: applying a template or
 * duplicating a slide always mints fresh ids, so the same template used
 * twice — or a slide duplicated — never produces a duplicate id). Not
 * limited to `<g>` containers: a slide nobody has run `convert` on yet still
 * carries its `id` directly on the primitive (ADR-0012's normal form is not
 * assumed here, the same posture `selection-runtime.js`'s `findSelectable`
 * takes), so every element with an `id` attribute is re-minted regardless of
 * tag. `data-comot-lock` and every other attribute/child is carried over
 * byte for byte; only `id` attribute values change. Any
 * `<comot:effect target="...">` naming a remapped id is updated to the new
 * id in the same pass, so the copy never carries a metadata reference to an
 * id that no longer exists anywhere in its own document.
 */
export function mintElementIds(
  svgContent: string,
  generateId: () => string = generateElementId,
  /**
   * [E2.T8]: comment ids live in their own namespace (`c-` prefix, never
   * `el-`) — re-minting them with `generateId` would hand a duplicated
   * slide's comments an element-shaped id. Separately injectable for the
   * same reason `generateId` is: deterministic tests.
   */
  generateCommentId: () => string = () => `c-${generateOpaqueId()}`,
): string {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }

  const usedIds = new Set<string>();
  collectAllIds(roots, usedIds);

  const idNodes: ScannedNode[] = [];
  const collectIdNodes = (node: ScannedNode): void => {
    if (attributeOf(node, "id")) idNodes.push(node);
    for (const child of node.children) collectIdNodes(child);
  };
  // `<metadata>` never carries an element id to re-mint — its `<comot:effect>`
  // / `<comot:comment>` children only ever *reference* one via `target`, and
  // are remapped below, not re-minted here.
  for (const child of svgRoot.children) {
    if (child.tag === "metadata") continue;
    collectIdNodes(child);
  }

  const mapping = new Map<string, string>();
  for (const node of idNodes) {
    const idAttr = attributeOf(node, "id")!;
    let candidate: string;
    do {
      candidate = generateId();
    } while (usedIds.has(candidate));
    usedIds.add(candidate);
    mapping.set(idAttr.value, candidate);
  }

  const splices: Splice[] = [];
  for (const node of idNodes) {
    const idAttr = attributeOf(node, "id")!;
    splices.push({ start: idAttr.start, end: idAttr.end, text: `id="${mapping.get(idAttr.value)}"` });
  }

  const metadata = svgRoot.children.find((child) => child.tag === "metadata");
  const effectsList = metadata?.children.find((child) => child.tag === "comot:effects");
  if (effectsList) {
    for (const effect of effectsList.children) {
      if (effect.tag !== "comot:effect") continue;
      const targetAttr = attributeOf(effect, "target");
      if (targetAttr && mapping.has(targetAttr.value)) {
        splices.push({ start: targetAttr.start, end: targetAttr.end, text: `target="${mapping.get(targetAttr.value)}"` });
      }
    }
  }

  // [E2.T8]: a duplicated slide's comments follow the same rule as its
  // effects — `target` is remapped when it names a re-minted element id
  // (`target="page"` is never in `mapping`, so it's left alone) — plus a
  // freshly minted `id` of their own, so the copy never carries a comment
  // id byte-identical to the source's.
  const commentsList = metadata?.children.find((child) => child.tag === "comot:comments");
  if (commentsList) {
    for (const comment of commentsList.children) {
      if (comment.tag !== "comot:comment") continue;
      const targetAttr = attributeOf(comment, "target");
      if (targetAttr && mapping.has(targetAttr.value)) {
        splices.push({ start: targetAttr.start, end: targetAttr.end, text: `target="${mapping.get(targetAttr.value)}"` });
      }
      const idAttr = attributeOf(comment, "id");
      if (idAttr) {
        let candidate: string;
        do {
          candidate = generateCommentId();
        } while (usedIds.has(candidate));
        usedIds.add(candidate);
        splices.push({ start: idAttr.start, end: idAttr.end, text: `id="${candidate}"` });
      }
    }
  }

  return applySplices(svgContent, splices);
}

function collectAllIds(nodes: readonly ScannedNode[], into: Set<string>): void {
  for (const node of nodes) {
    const idAttr = attributeOf(node, "id");
    if (idAttr) into.add(idAttr.value);
    collectAllIds(node.children, into);
  }
}

function formatSlideNumber(n: number): string {
  return String(n).padStart(3, "0");
}

/** The smallest number not currently used as a `NNN.svg` filename directly under `dirName` — a gap left by a deleted slide is filled before a new number is minted, never left behind (第 4.1 節). */
async function nextAvailableNumber(id: string, dirName: string): Promise<number> {
  let entries: string[];
  try {
    entries = await listPresentationEntries(id, dirName);
  } catch (error) {
    if (error instanceof CoMotionNotFoundError) {
      entries = [];
    } else {
      throw error;
    }
  }
  const used = new Set<number>();
  for (const entry of entries) {
    const match = /^(\d{3})\.svg$/.exec(entry);
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function assertValidIndex(index: number, max: number, argName: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new CoMotionError(`${argName} 超出範圍：${index}`);
  }
}

export interface AddSlideInput {
  /** Virtual path of a template listed in `project.json`'s `templates`. Omit for a blank slide. */
  templatePath?: string;
  /** Insertion index into `slides`. Omit to append at the end. */
  at?: number;
}

export interface AddSlideResult {
  slidePath: string;
}

/**
 * `co-motion slide add` (T3, AC 1/2). With `templatePath`, the new slide is
 * the template's content byte-for-byte except every element id, which is
 * re-minted (`mintElementIds`) — `data-comot-lock` carries over unchanged.
 * `project.json` and the new SVG are written in one history group so undo
 * removes both together.
 */
export async function addSlide(id: string, input: AddSlideInput = {}): Promise<AddSlideResult> {
  const project = await readProject(id);

  let content: string;
  if (input.templatePath !== undefined) {
    const templates = readTemplateEntries(project);
    if (templates.some((template) => template.file === input.templatePath)) {
      const raw = await readPresentationFile(id, input.templatePath);
      content = mintElementIds(raw);
    } else if (project.slides.includes(input.templatePath)) {
      throw new CoMotionError(`不是範本：${input.templatePath}`);
    } else {
      throw new CoMotionNotFoundError(`找不到範本：${input.templatePath}`);
    }
  } else {
    content = buildBlankSlideSvg(project.canvas);
  }

  const at = input.at ?? project.slides.length;
  assertValidIndex(at, project.slides.length, "--at");

  const number = await nextAvailableNumber(id, "slides");
  const slidePath = `slides/${formatSlideNumber(number)}.svg`;
  const nextSlides = [...project.slides];
  nextSlides.splice(at, 0, slidePath);

  const openedGroup = await beginHistoryGroup(id);
  try {
    await createPresentationFile(id, slidePath, Buffer.from(content, "utf-8"));
    await writeProject(id, { ...project, slides: nextSlides });
  } finally {
    if (openedGroup) await endHistoryGroup(id);
  }

  return { slidePath };
}

/**
 * `co-motion slide delete` (T3, AC 4). Allowed to bring `slides` down to
 * zero (`validateProjectJson` treats an empty `slides` as structurally
 * legal) and allowed on a slide carrying locked elements — deleting the
 * whole slide is not an edit ADR-0013 restricts.
 */
export async function deleteSlide(id: string, slidePath: string): Promise<void> {
  const project = await readProject(id);
  if (!project.slides.includes(slidePath)) {
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }
  const nextSlides = project.slides.filter((entry) => entry !== slidePath);

  const openedGroup = await beginHistoryGroup(id);
  try {
    await deletePresentationFile(id, slidePath);
    await writeProject(id, { ...project, slides: nextSlides });
  } finally {
    if (openedGroup) await endHistoryGroup(id);
  }
}

export interface DuplicateSlideResult {
  slidePath: string;
}

/** `co-motion slide duplicate` (T3, AC 5): inserted directly after the source; every element id (and nothing else) is re-minted; `<comot:notes>` is copied verbatim along with the rest of the document. */
export async function duplicateSlide(id: string, slidePath: string): Promise<DuplicateSlideResult> {
  const project = await readProject(id);
  const sourceIndex = project.slides.indexOf(slidePath);
  if (sourceIndex === -1) {
    if (readTemplateEntries(project).some((template) => template.file === slidePath)) {
      throw new CoMotionError(`不是投影片：${slidePath}（複製範本請用 template add --from）`);
    }
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }

  const raw = await readPresentationFile(id, slidePath);
  const content = mintElementIds(raw);

  const number = await nextAvailableNumber(id, "slides");
  const newPath = `slides/${formatSlideNumber(number)}.svg`;
  const nextSlides = [...project.slides];
  nextSlides.splice(sourceIndex + 1, 0, newPath);

  const openedGroup = await beginHistoryGroup(id);
  try {
    await createPresentationFile(id, newPath, Buffer.from(content, "utf-8"));
    await writeProject(id, { ...project, slides: nextSlides });
  } finally {
    if (openedGroup) await endHistoryGroup(id);
  }

  return { slidePath: newPath };
}

/** `co-motion slide move` (T3, AC 6): rewrites only `project.json`'s `slides` order — no SVG file is opened or written, so every slide's bytes stay exactly as they were (ADR-0008). */
export async function moveSlide(id: string, slidePath: string, newIndex: number): Promise<void> {
  const project = await readProject(id);
  const currentIndex = project.slides.indexOf(slidePath);
  if (currentIndex === -1) {
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }
  assertValidIndex(newIndex, project.slides.length - 1, "new-index");

  const nextSlides = [...project.slides];
  nextSlides.splice(currentIndex, 1);
  nextSlides.splice(newIndex, 0, slidePath);
  await writeProject(id, { ...project, slides: nextSlides });
}

export interface AddTemplateInput {
  /** Virtual path of an existing slide to copy from. Omit for a blank template. */
  from?: string;
  /** User-visible name (trimmed). Omit to default to the new file's basename (A11's fallback rule). */
  name?: string;
}

export interface AddTemplateResult {
  templatePath: string;
}

/**
 * `co-motion template add` (T3/[E4.T7], AC 8, A10): registers the new path
 * in `project.json`'s `templates` (created if this is the presentation's
 * first template) — never in `slides`. A blank/whitespace-only `--name` is
 * rejected before any file is created or `project.json` touched (A4: a
 * cancelled/failed "save as template" leaves no residue).
 */
export async function addTemplate(id: string, input: AddTemplateInput = {}): Promise<AddTemplateResult> {
  const trimmedName = input.name?.trim();
  if (input.name !== undefined && trimmedName === "") {
    throw new CoMotionError("範本名稱不可為空");
  }

  const project = await readProject(id);

  let content: string;
  if (input.from !== undefined) {
    if (!project.slides.includes(input.from)) {
      throw new CoMotionNotFoundError(`找不到投影片：${input.from}`);
    }
    const raw = await readPresentationFile(id, input.from);
    content = mintElementIds(raw);
  } else {
    content = buildBlankSlideSvg(project.canvas);
  }

  const number = await nextAvailableNumber(id, "templates");
  const templatePath = `templates/${formatSlideNumber(number)}.svg`;
  const name = trimmedName ?? formatSlideNumber(number);
  const nextTemplates: TemplateEntry[] = [...readTemplateEntries(project), { file: templatePath, name }];

  const openedGroup = await beginHistoryGroup(id);
  try {
    await createPresentationFile(id, templatePath, Buffer.from(content, "utf-8"));
    await writeProject(id, { ...project, templates: nextTemplates });
  } finally {
    if (openedGroup) await endHistoryGroup(id);
  }

  return { templatePath };
}

/** `co-motion template list` ([E4.T7], A10): the presentation's templates in `project.json` order, normalized (A11's filename fallback for pre-upgrade entries). */
export async function listTemplates(id: string): Promise<TemplateEntry[]> {
  const project = await readProject(id);
  return readTemplateEntries(project);
}

/**
 * `co-motion template rename` ([E4.T7], A5/A6/A10): renames a template's
 * `name` field only — never the SVG file or its path. A single-file write,
 * so (unlike `deleteTemplate`) it needs no history group to be one undo
 * step (compare `moveSlide`). Two templates may share a name (A6) — no
 * uniqueness check, ever.
 */
export async function renameTemplate(id: string, templatePath: string, newName: string): Promise<void> {
  const trimmed = newName.trim();
  if (trimmed === "") {
    throw new CoMotionError("範本名稱不可為空");
  }

  const project = await readProject(id);
  const entries = readTemplateEntries(project);
  const index = entries.findIndex((entry) => entry.file === templatePath);
  if (index === -1) {
    if (project.slides.includes(templatePath)) {
      throw new CoMotionError(`不是範本：${templatePath}`);
    }
    throw new CoMotionNotFoundError(`找不到範本：${templatePath}`);
  }

  const nextTemplates = [...entries];
  nextTemplates[index] = { ...nextTemplates[index], name: trimmed };
  await writeProject(id, { ...project, templates: nextTemplates });
}

/**
 * `co-motion template delete` ([E4.T7], A8/A9/A10): deletes the SVG file
 * and removes its `templates` entry in one history group (A9: one undo
 * step restores both). ADR-0013 — a template is dead once applied — so
 * deleting it never touches, scans, or warns about slides already built
 * from it.
 */
export async function deleteTemplate(id: string, templatePath: string): Promise<void> {
  const project = await readProject(id);
  const entries = readTemplateEntries(project);
  if (!entries.some((entry) => entry.file === templatePath)) {
    if (project.slides.includes(templatePath)) {
      throw new CoMotionError(`不是範本：${templatePath}（刪除投影片請用 slide delete）`);
    }
    throw new CoMotionNotFoundError(`找不到範本：${templatePath}`);
  }
  const nextTemplates = entries.filter((entry) => entry.file !== templatePath);

  const openedGroup = await beginHistoryGroup(id);
  try {
    await deletePresentationFile(id, templatePath);
    await writeProject(id, { ...project, templates: nextTemplates });
  } finally {
    if (openedGroup) await endHistoryGroup(id);
  }
}

/** `co-motion slide notes set` (T3, AC 11) — slides only, never templates (a template's speaker notes have no display-time meaning). */
export async function setNotes(id: string, slidePath: string, text: string): Promise<void> {
  const project = await readProject(id);
  if (!project.slides.includes(slidePath)) {
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }
  const original = await readPresentationFile(id, slidePath);
  const updated = setSlideNotes(original, text);
  await writePresentationFile(id, slidePath, updated);
}

/** A comment read back out with the slide it lives on — `comment list`'s and `listAllComments`'s output shape. */
export interface SlideCommentWithPath extends SlideComment {
  slidePath: string;
}

function requireSlidePath(project: ProjectJson, slidePath: string): void {
  if (!project.slides.includes(slidePath)) {
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }
}

function findElementById(elements: readonly SlideElement[], target: string): boolean {
  for (const element of elements) {
    if (element.id === target) return true;
    if (findElementById(element.children, target)) return true;
  }
  return false;
}

/**
 * [E2.T8] `co-motion comment add`: `target` is an element id or the literal
 * `"page"`. Slides only (a template's comments have no display-time
 * meaning, same rule `setNotes` follows). Rejects a dangling `target` up
 * front — `element delete`'s dangling-comment cleanup only promises to
 * clean up comments *created* pointing at something real, not to repair
 * comments that never did.
 */
export async function addComment(id: string, slidePath: string, target: string, text: string, author = "agent"): Promise<string> {
  const project = await readProject(id);
  requireSlidePath(project, slidePath);
  if (author.trim() === "") {
    throw new CoMotionError("author 不可為空");
  }
  if (text.trim() === "") {
    throw new CoMotionError("留言內容不可為空");
  }
  const original = await readPresentationFile(id, slidePath);
  assertSlideCompliant(original, slidePath);
  if (target !== "page") {
    const slide = parseSlide(original, slidePath);
    if (!findElementById(slide.elements, target)) {
      throw new CoMotionError(`投影片 ${slidePath} 裡沒有元素 ${target}`);
    }
  }
  const commentId = `c-${generateOpaqueId()}`;
  const updated = addSlideComment(original, {
    id: commentId,
    target,
    author,
    created: new Date().toISOString(),
    text,
  });
  await writePresentationFile(id, slidePath, updated);
  return commentId;
}

/** [E2.T8] `co-motion comment edit`: replaces a comment's text; `created` is left untouched. Unknown `commentId` propagates `CoMotionNotFoundError`. */
export async function editComment(id: string, slidePath: string, commentId: string, text: string): Promise<void> {
  const project = await readProject(id);
  requireSlidePath(project, slidePath);
  if (text.trim() === "") {
    throw new CoMotionError("留言內容不可為空");
  }
  const original = await readPresentationFile(id, slidePath);
  const updated = editSlideComment(original, commentId, text);
  await writePresentationFile(id, slidePath, updated);
}

/** [E2.T8] `co-motion comment delete`. Unknown `commentId` propagates `CoMotionNotFoundError`. */
export async function deleteComment(id: string, slidePath: string, commentId: string): Promise<void> {
  const project = await readProject(id);
  requireSlidePath(project, slidePath);
  const original = await readPresentationFile(id, slidePath);
  const updated = deleteSlideComment(original, commentId);
  await writePresentationFile(id, slidePath, updated);
}

/** [E2.T8] `co-motion comment list <id> <slide-path>`: one slide's comments, in document order. */
export async function listComments(id: string, slidePath: string): Promise<SlideCommentWithPath[]> {
  const project = await readProject(id);
  requireSlidePath(project, slidePath);
  const raw = await readPresentationFile(id, slidePath);
  return readSlideComments(raw).map((comment) => ({ ...comment, slidePath }));
}

/**
 * [E2.T8] `co-motion comment list <id>` (no `slide-path`): every slide's
 * comments, deck-wide, in `project.json`'s `slides` order (then document
 * order within a slide) — the same order `/api/chat`'s context prefix
 * (server's `session.ts`) and the front end's Pinned context numbering
 * (`sortComments`) both rely on.
 */
export async function listAllComments(id: string): Promise<SlideCommentWithPath[]> {
  const project = await readProject(id);
  const all: SlideCommentWithPath[] = [];
  for (const slidePath of project.slides) {
    const raw = await readPresentationFile(id, slidePath);
    for (const comment of readSlideComments(raw)) {
      all.push({ ...comment, slidePath });
    }
  }
  return all;
}

const VALID_TRANSITIONS = ["none", "fade"] as const;

/** `co-motion presentation transition set` (T3, AC 12) — stores only; nothing plays it back (`player-runtime.js`/`player-plan.ts` are untouched). */
export async function setTransition(id: string, name: string): Promise<void> {
  if (!(VALID_TRANSITIONS as readonly string[]).includes(name)) {
    throw new CoMotionError(`不支援的轉場效果：${name}，可用值為 ${VALID_TRANSITIONS.join("、")}`);
  }
  const project = await readProject(id);
  await writeProject(id, { ...project, transition: name });
}
