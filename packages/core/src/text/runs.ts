import { unescapeXmlText } from "../element-text.js";
import { attributeValue, type ScannedNode } from "../slide/scan.js";

/**
 * A character-range style override on a text box's content string
 * (NOOP-65, `co-motion text style set`). Ranges are half-open `[start,
 * end)` in the CONTENT STRING's index space — the same space
 * `text/wrap.ts`'s hard-break-aware round trip defines (a `"\n"` counts as
 * one character; a list marker, once lists exist, never will).
 *
 * The event-of-record is the `<tspan>` tree itself (NOOP-65 決定 B —
 * 已定案): there is no side table of runs kept anywhere. This module only
 * ever computes a `TextRun[]` transiently, either read back from existing
 * markup (`readTextBoxRuns`) or built for `render.ts` to bake into new
 * markup (`applyRunStyle`).
 *
 * `fontWeight`/`fontStyle` are the exact SVG attribute values to write
 * (`"bold"`, `"700"`, `"italic"`) — never `"normal"`, which this module
 * represents as the attribute's absence (`undefined`), matching how
 * `text style set --font-weight normal` removes the attribute rather than
 * writing it.
 */
export interface TextRun {
  readonly start: number;
  readonly end: number;
  readonly fontWeight?: string;
  readonly fontStyle?: string;
}

interface RunAttrs {
  readonly fontWeight?: string;
  readonly fontStyle?: string;
}

function attrsEqual(a: RunAttrs, b: RunAttrs): boolean {
  return a.fontWeight === b.fontWeight && a.fontStyle === b.fontStyle;
}

function attrsAt(runs: readonly TextRun[], pos: number): RunAttrs {
  const run = runs.find((candidate) => candidate.start <= pos && pos < candidate.end);
  return run ? { fontWeight: run.fontWeight, fontStyle: run.fontStyle } : {};
}

function mergeAdjacent(runs: readonly TextRun[]): TextRun[] {
  const sorted = [...runs].sort((a, b) => a.start - b.start);
  const merged: TextRun[] = [];
  for (const run of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.end === run.start && attrsEqual(last, run)) {
      merged[merged.length - 1] = { ...last, end: run.end };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

/**
 * Sets (or clears) `fontWeight`/`fontStyle` over `[start, end)`, returning
 * a brand-new run list — `runs` itself is never mutated. Either field may
 * be omitted from `update` to leave that axis untouched over the whole
 * range; `null` clears it (the `--font-weight normal` / `--font-style
 * normal` case), a string sets it.
 *
 * Existing runs that only partially overlap `[start, end)` are split at
 * the boundary, so the untouched portion keeps its original attributes
 * exactly. Adjacent runs whose attributes end up identical are merged
 * back into one (NOOP-65 §4.2 決定); a resulting run with neither
 * attribute set is dropped rather than kept as an empty tspan.
 */
export function applyRunStyle(
  runs: readonly TextRun[],
  start: number,
  end: number,
  update: { readonly fontWeight?: string | null; readonly fontStyle?: string | null },
): TextRun[] {
  const boundarySet = new Set<number>([start, end]);
  for (const run of runs) {
    if (run.start > start && run.start < end) boundarySet.add(run.start);
    if (run.end > start && run.end < end) boundarySet.add(run.end);
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);

  const untouched = runs.filter((run) => run.end <= start || run.start >= end);
  const clippedBefore = runs
    .filter((run) => run.start < start && run.end > start)
    .map((run) => ({ ...run, end: start }));
  const clippedAfter = runs
    .filter((run) => run.start < end && run.end > end)
    .map((run) => ({ ...run, start: end }));

  const newSegments: TextRun[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    if (segStart >= segEnd) continue;
    const current = attrsAt(runs, segStart);
    const fontWeight =
      update.fontWeight === undefined ? current.fontWeight : update.fontWeight === null ? undefined : update.fontWeight;
    const fontStyle =
      update.fontStyle === undefined ? current.fontStyle : update.fontStyle === null ? undefined : update.fontStyle;
    if (fontWeight !== undefined || fontStyle !== undefined) {
      newSegments.push({ start: segStart, end: segEnd, fontWeight, fontStyle });
    }
  }

  const all = [...untouched, ...clippedBefore, ...clippedAfter, ...newSegments]
    .filter((run) => run.start < run.end)
    .sort((a, b) => a.start - b.start);

  return mergeAdjacent(all);
}

/** The content string plus its runs, in one interleaved read — `readTextBoxRuns`'s per-line worker. */
function readLineContent(
  lineNode: ScannedNode,
  svgContent: string,
  offset: number,
): { text: string; runs: TextRun[] } {
  let text = "";
  const runs: TextRun[] = [];
  let cursor = lineNode.contentStart;
  for (const child of lineNode.children) {
    if (child.start > cursor) {
      text += unescapeXmlText(svgContent.slice(cursor, child.start));
    }
    const start = offset + text.length;
    text += unescapeXmlText(svgContent.slice(child.contentStart, child.contentEnd));
    const fontWeight = attributeValue(child, "font-weight") ?? undefined;
    const fontStyle = attributeValue(child, "font-style") ?? undefined;
    if (fontWeight !== undefined || fontStyle !== undefined) {
      runs.push({ start, end: offset + text.length, fontWeight, fontStyle });
    }
    cursor = child.end;
  }
  if (lineNode.contentEnd > cursor) {
    text += unescapeXmlText(svgContent.slice(cursor, lineNode.contentEnd));
  }
  return { text, runs };
}

/**
 * Reads a text box's `<text>` content back into its content string plus
 * the `TextRun[]` its nested tspans encode (NOOP-65 決定 B). `textNode`'s
 * direct children are the per-line tspans (`data-comot-text-width`'s
 * baked-in wrap); each line's own children, if any, are its run tspans.
 *
 * A line whose own opening tspan carries `data-comot-break="1"` had a
 * `"\n"` after it in the original content string (NOOP-65 決定 A) — that
 * character is appended here, and — matching `wrapText`'s own contract —
 * it is never covered by a run.
 */
export function readTextBoxRuns(textNode: ScannedNode, svgContent: string): { content: string; runs: TextRun[] } {
  const lineNodes = textNode.children.filter((child) => child.tag === "tspan");
  let content = "";
  const runs: TextRun[] = [];
  for (const lineNode of lineNodes) {
    const { text, runs: lineRuns } = readLineContent(lineNode, svgContent, content.length);
    content += text;
    runs.push(...lineRuns);
    if (attributeValue(lineNode, "data-comot-break") === "1") {
      content += "\n";
    }
  }
  return { content, runs: mergeAdjacent(runs) };
}
