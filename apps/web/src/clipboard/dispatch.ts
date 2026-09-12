import type { ClipboardTextKind } from "./payload.js";

/**
 * [E2.T18] 計畫「補充：與 [E2.T14] 的軟依賴介面」(b). A cell-range selection
 * on a table, addressed the same way core's `parseCellRange` addresses one
 * (0-based, inclusive).
 */
export interface CellRange {
  tableElementId: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** What ⌘C/⌘X/⌘V should act on right now. `null` means nothing selected — every command-builder below reads that as a no-op. */
export type ClipboardTarget =
  | { kind: "elements"; slidePath: string; elementIds: string[] }
  | { kind: "cells"; slidePath: string; range: CellRange }
  | null;

/**
 * Reads the current cell-range selection, if any. Always returns `null` in
 * this ticket — cell-range hit-testing/selection lives in [E2.T14]'s
 * `selection-runtime.js` changes. The one thing [E2.T14] needs to change
 * after merging is this function's implementation; nothing in `dispatch.ts`
 * itself (决定 §6 補充 (b)).
 */
export type CellRangeProvider = () => CellRange | null;

export type ClipboardCommand =
  | { name: "element copy"; input: { slidePath: string; elementIds: string[] } }
  | { name: "element cut"; input: { slidePath: string; elementIds: string[] } }
  | { name: "element paste"; input: { slidePath: string; svg: string; dx: number; dy: number } }
  | { name: "table cell copy"; input: { slidePath: string; elementId: string; range: string } }
  | { name: "table cell cut"; input: { slidePath: string; elementId: string; range: string } }
  | { name: "table cell paste"; input: { slidePath: string; elementId: string; at: string; tsv: string } };

function rangeFlag(range: CellRange): string {
  return `${range.top},${range.left}:${range.bottom},${range.right}`;
}

/** ⌘C / the ContextBar Copy button. `null` target (nothing selected) is a no-op. */
export function copyCommandFor(target: ClipboardTarget): ClipboardCommand | null {
  if (!target) return null;
  if (target.kind === "elements") {
    return { name: "element copy", input: { slidePath: target.slidePath, elementIds: target.elementIds } };
  }
  return {
    name: "table cell copy",
    input: { slidePath: target.slidePath, elementId: target.range.tableElementId, range: rangeFlag(target.range) },
  };
}

/** ⌘X / the ContextBar Cut button. Same routing as `copyCommandFor`. */
export function cutCommandFor(target: ClipboardTarget): ClipboardCommand | null {
  if (!target) return null;
  if (target.kind === "elements") {
    return { name: "element cut", input: { slidePath: target.slidePath, elementIds: target.elementIds } };
  }
  return {
    name: "table cell cut",
    input: { slidePath: target.slidePath, elementId: target.range.tableElementId, range: rangeFlag(target.range) },
  };
}

/**
 * ⌘V / the ContextBar Paste button / the window `paste` event. Routes on
 * the pasted *content*, not the current selection (計畫 §4.3): a slidra
 * elements payload always goes to `element paste`, regardless of what (if
 * anything) is selected; plain text only goes anywhere when a cell range is
 * selected. `slidePath` is the slide to paste onto — it cannot be read off
 * `target` alone, since `target` is `null` whenever nothing is selected,
 * which a paste must still handle (pasting elements needs no selection).
 */
export function pasteCommandFor(
  target: ClipboardTarget,
  text: ClipboardTextKind,
  slidePath: string,
  offset: { dx: number; dy: number },
): ClipboardCommand | null {
  if (text.kind === "slidra-elements") {
    return { name: "element paste", input: { slidePath, svg: text.svg, dx: offset.dx, dy: offset.dy } };
  }
  if (text.kind === "plain" && target?.kind === "cells") {
    return {
      name: "table cell paste",
      input: {
        slidePath: target.slidePath,
        elementId: target.range.tableElementId,
        at: `${target.range.top},${target.range.left}`,
        tsv: text.text,
      },
    };
  }
  return null;
}
