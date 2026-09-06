import { escapeXmlAttr, escapeXmlText } from "../element-text.js";
import { formatSvgNumber } from "../svg-number.js";
import type { WrappedLine } from "./wrap.js";
import type { TextRun } from "./runs.js";

/**
 * Serializes wrapped lines into the inner markup of a text box's `<text>`
 * element: one `<tspan x="…" y="…">…</tspan>` per line, with `data-comot-break="1"`
 * on a line that ends on a hard break (NOOP-65 決定 A), and — when `runs`
 * covers part of a line — a nested `<tspan font-weight="…" font-style="…">`
 * per run segment (NOOP-65 決定 B).
 *
 * No whitespace whatsoever between `<text>` and the first `<tspan>`, none
 * between tspans, and none between an outer tspan and its nested run
 * tspans. The `<text>` this is spliced into carries `xml:space="preserve"`
 * (so the exact source text a browser lays out agrees with what
 * `measureTextWidth` measured), and under that attribute any indentation
 * here is rendered content, not formatting — pretty-printing would
 * visibly corrupt every text box.
 *
 * No Node built-in import, not even transitively (#76): this module
 * reuses `escapeXmlText`/`escapeXmlAttr` from `../element-text.js`, which
 * that module made Node-free for exactly this reason (see its header
 * comment).
 */
export function renderTextBoxContent(lines: readonly WrappedLine[], runs: readonly TextRun[] = []): string {
  let cursor = 0;
  return lines
    .map((line) => {
      const lineStart = cursor;
      cursor = lineStart + line.text.length + (line.hardBreak ? 1 : 0);
      const breakAttr = line.hardBreak ? ' data-comot-break="1"' : "";
      const inner = renderLineRuns(line.text, lineStart, runs);
      return `<tspan x="${formatSvgNumber(line.x)}" y="${formatSvgNumber(line.y)}"${breakAttr}>${inner}</tspan>`;
    })
    .join("");
}

/**
 * One line's inner markup: plain escaped text where no run covers a
 * character, a nested `<tspan font-weight="…" font-style="…">` for each
 * run segment that overlaps the line. `lineStart` is `text`'s offset in
 * the content-string index space `runs`' ranges are expressed in.
 */
function renderLineRuns(text: string, lineStart: number, runs: readonly TextRun[]): string {
  const lineEnd = lineStart + text.length;
  const relevant = runs
    .filter((run) => run.start < lineEnd && run.end > lineStart)
    .slice()
    .sort((a, b) => a.start - b.start);

  let result = "";
  let pos = lineStart;
  for (const run of relevant) {
    const segStart = Math.max(run.start, lineStart);
    const segEnd = Math.min(run.end, lineEnd);
    if (segStart > pos) {
      result += escapeXmlText(text.slice(pos - lineStart, segStart - lineStart));
    }
    const weightAttr = run.fontWeight !== undefined ? ` font-weight="${escapeXmlAttr(run.fontWeight)}"` : "";
    const styleAttr = run.fontStyle !== undefined ? ` font-style="${escapeXmlAttr(run.fontStyle)}"` : "";
    result += `<tspan${weightAttr}${styleAttr}>${escapeXmlText(text.slice(segStart - lineStart, segEnd - lineStart))}</tspan>`;
    pos = segEnd;
  }
  if (pos < lineEnd) {
    result += escapeXmlText(text.slice(pos - lineStart));
  }
  return result;
}
