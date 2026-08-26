import { CoMotionError } from "../errors.js";

/**
 * Pure arithmetic over a presentation's `project.json` `slides` array
 * (#85, 投影片層級操作). No Node built-ins here — this file has to load in
 * a browser exactly like the rest of `slide/` (see `slide/index.ts`'s
 * barrel comment), because it expresses only "what a legal slide order
 * looks like", never how to read or write one.
 *
 * `1000th slide`, `1-based page positions and every legal-range boundary
 * described in the design's §5 table are settled here, once, before any
 * I/O exists — `workspace.ts`'s four slide operations call these and do
 * nothing of their own to re-derive the same arithmetic.
 */

/** Finds every index in `slides` equal to `slidePath`. */
function findOccurrences(slides: readonly string[], slidePath: string): number[] {
  const indices: number[] = [];
  slides.forEach((entry, index) => {
    if (entry === slidePath) indices.push(index);
  });
  return indices;
}

/**
 * Asserts `slidePath` appears in `slides` exactly once, throwing the same
 * wording `workspace.ts`'s `assertSlidePathListed` already uses for "not
 * listed at all", plus a distinct error for a corrupt deck that lists the
 * same path twice (errors over fallbacks: never guess which occurrence was
 * meant). Returns the single 0-based index found.
 */
function assertSingleOccurrence(slides: readonly string[], slidePath: string): number {
  const indices = findOccurrences(slides, slidePath);
  if (indices.length === 0) {
    throw new CoMotionError(`不是投影片：${slidePath}`);
  }
  if (indices.length > 1) {
    throw new CoMotionError(`簡報設定檔的投影片順序重複：${slidePath}`);
  }
  return indices[0];
}

/**
 * Inserts `slidePath` at 1-based position `at` (1..slides.length+1 — the
 * "+1" is "after the last slide", the default `slide add` uses). Throws
 * naming the legal range for 0, negative, non-integer, `NaN`, or anything
 * past the last legal insertion point.
 */
export function insertSlidePathAt(slides: readonly string[], slidePath: string, at: number): string[] {
  const maxAt = slides.length + 1;
  if (!Number.isInteger(at) || at < 1 || at > maxAt) {
    throw new CoMotionError(`--at 必須是 1 到 ${maxAt} 之間的整數`);
  }
  const result = slides.slice();
  result.splice(at - 1, 0, slidePath);
  return result;
}

/**
 * Removes `slidePath` from `slides`. Refuses to remove the deck's last
 * remaining slide — `packages/server/src/serve.ts` refuses to serve a
 * zero-slide deck, so allowing this would mean "delete" can create an
 * unopenable presentation.
 */
export function removeSlidePath(slides: readonly string[], slidePath: string): string[] {
  const index = assertSingleOccurrence(slides, slidePath);
  if (slides.length === 1) {
    throw new CoMotionError("簡報至少要有一張投影片，無法刪除");
  }
  const result = slides.slice();
  result.splice(index, 1);
  return result;
}

/**
 * Moves `slidePath` to 1-based position `to` (1..slides.length — moving
 * cannot create a new slot, unlike insert). When `to` already equals the
 * slide's current 1-based position, the returned array is content-equal to
 * `slides` (same order) — the caller compares before/after to decide
 * `changed: false` and skip writing anything.
 */
export function moveSlidePath(slides: readonly string[], slidePath: string, to: number): string[] {
  const from = assertSingleOccurrence(slides, slidePath);
  const maxTo = slides.length;
  if (!Number.isInteger(to) || to < 1 || to > maxTo) {
    throw new CoMotionError(`--to 必須是 1 到 ${maxTo} 之間的整數`);
  }
  const result = slides.slice();
  const [item] = result.splice(from, 1);
  result.splice(to - 1, 0, item);
  return result;
}

/**
 * Nothing in the repo defines slide file naming before this function —
 * this is the first thing that does (W3-R5). Allocates the bare filename
 * (e.g. "001.svg" -> "005.svg" given ["001.svg", "004.svg"]) one past the
 * highest `NNN.svg` name found in `existingNames`, padded to at least 3
 * digits (the padding is a minimum, not a cap: the 1000th slide is
 * "1000.svg"). Names that are not `NNN.svg` are ignored for the max, so a
 * stray non-numeric file never perturbs allocation.
 *
 * Takes the directory's actual entries, not `project.json`'s `slides`
 * array, so an orphan file left behind by an undone `slide add` is never
 * reused/clobbered by the next `slide add`.
 */
export function nextSlideFileName(existingNames: readonly string[]): string {
  let max = 0;
  for (const name of existingNames) {
    const match = /^(\d+)\.svg$/.exec(name);
    if (!match) continue;
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  return `${String(max + 1).padStart(3, "0")}.svg`;
}

/**
 * The blank slide `slide add` writes: a compliant `<svg>` root (per
 * `checkSlideCompliance`, an empty `<svg>` with a `viewBox` produces zero
 * issues) sized to the deck's own canvas.
 */
export function buildBlankSlideSvg(canvas: { width: number; height: number }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}">\n</svg>\n`;
}
