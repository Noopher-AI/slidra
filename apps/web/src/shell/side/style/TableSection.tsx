import { useEffect, useState } from "react";
import type { CellAlign } from "../../../slide-dom.js";
import type { CanvasController, CanvasState } from "../../../canvas.js";
import type { CellRange } from "../../../table-overlay.js";

export interface TableSectionProps {
  state: CanvasState;
  controller: CanvasController | null;
  elementId: string;
  theme: "dark" | "light" | "zebra";
  header: boolean;
  /** Non-null when the table is bound to a CSV source (plan §4.4). */
  source: string | null;
}

const THEMES: { value: "dark" | "light" | "zebra"; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "zebra", label: "Zebra" },
];

const ALIGNS: { value: CellAlign; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

/**
 * Style › Object's table section (E2.T14/E2.T14r2, plan §0(b)/§4.4/§5 E12/
 * E12b): theme/header toggles, the Cell block (align/fill/text-fill on the
 * active cell range), and — only for a bound table — the source path plus a
 * Refresh button. `StyleObjectPanel.tsx` renders this in place of its own
 * empty container exactly when the current selection is a single table.
 *
 * The Cell block reads the active range off `CanvasController.subscribeTableRange`
 * (plan §4.1's shared owner — `canvas.ts`, not this panel and not the stage
 * overlay's own local state) and the cell data off `state.selection.elements[0].table.cells`
 * rather than adding a new prop: `elementId` is always `state.selection.ids[0]`
 * whenever this component renders at all (`StyleObjectPanel.tsx`'s own
 * single-table guard), so the two already agree.
 */
export function TableSection({ state, controller, elementId, theme, header, source }: TableSectionProps) {
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;
  const cells = state.selection.elements[0]?.table?.cells ?? [];
  const [range, setRange] = useState<CellRange | null>(null);

  useEffect(() => {
    if (!controller) return;
    return controller.subscribeTableRange((value) => {
      setRange(value && value.tableId === elementId ? value.range : null);
    });
  }, [controller, elementId]);

  async function run(name: string, input: Record<string, unknown>): Promise<void> {
    if (!controller || !slidePath) return;
    await controller.runCommand(name, { slidePath, elementId, ...input });
  }

  /** Plan §4.4: one command per change, covering the WHOLE range (not just the top-left cell shown here) via row/col/rowEnd/colEnd. */
  async function runCellStyle(attr: "align" | "fill" | "text-fill", value: string): Promise<void> {
    if (!range) return;
    await run("table cell style set", { row: range.r0, col: range.c0, rowEnd: range.r1, colEnd: range.c1, attr, value });
  }

  // §4.4: multiple cells with differing values show the top-left cell's own
  // value, never a "mixed" state (§2.21's extension) — `topLeft` below is
  // exactly that lookup, and doubles as "is a range active at all" (no
  // range, or a stale one whose top-left cell no longer resolves, renders
  // nothing).
  const topLeft = range ? cells.find((cell) => cell.row === range.r0 && cell.col === range.c0) : undefined;

  return (
    <div className="style-section table-section">
      <div className="table-section-row" role="group" aria-label="Theme">
        {THEMES.map((item) => (
          <button
            key={item.value}
            type="button"
            className="table-section-theme"
            aria-pressed={theme === item.value}
            onClick={() => void run("table theme set", { theme: item.value })}
          >
            {item.label}
          </button>
        ))}
      </div>
      <label className="table-section-row table-section-header-toggle">
        <input
          type="checkbox"
          checked={header}
          onChange={(event) => void run("table header set", { header: event.target.checked })}
        />
        Header row
      </label>
      {range && topLeft && (
        <div className="table-section-row table-section-cell" role="group" aria-label="Cell">
          {ALIGNS.map((item) => (
            <button
              key={item.value}
              type="button"
              className="table-section-align"
              data-align={item.value}
              aria-pressed={topLeft.align === item.value}
              onClick={() => void runCellStyle("align", item.value)}
            >
              {item.label}
            </button>
          ))}
          <label className="table-section-color">
            Fill
            <input type="color" value={topLeft.fill} onChange={(event) => void runCellStyle("fill", event.target.value)} />
          </label>
          <label className="table-section-color">
            Text
            <input
              type="color"
              value={topLeft.textFill}
              onChange={(event) => void runCellStyle("text-fill", event.target.value)}
            />
          </label>
        </div>
      )}
      {source !== null && (
        <div className="table-section-row table-section-binding">
          <span className="table-section-source" title={source}>
            {source}
          </span>
          <button type="button" className="table-section-refresh" onClick={() => void run("table refresh", {})}>
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
