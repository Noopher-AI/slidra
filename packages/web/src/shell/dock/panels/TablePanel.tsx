import { useState } from "react";
import type { CanvasController } from "../../../canvas.js";

export type TableTheme = "dark" | "light" | "zebra";

export interface TablePanelProps {
  onClose(): void;
  controller: CanvasController | null;
  /** The presentation's own canvas size — `null` before it has loaded, which disables Insert (same posture as `TextPanel`). */
  canvasSize: { width: number; height: number } | null;
  /** The current slide's virtual path — `table create` needs it like every other command. `null` before a slide has loaded, which disables Insert. */
  slidePath: string | null;
}

const GRID_ROWS = 6;
const GRID_COLS = 8;
const THEMES: { value: TableTheme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "zebra", label: "Zebra" },
];

/**
 * Table insert panel: an 8x6 grid with hover preview, click to lock in the
 * size, three theme buttons, a header toggle, Insert sends `table create`.
 * Position is fixed at 10%/20% from the canvas's top-left — the CLI's
 * `--x`/`--y` have no default, this is purely the GUI's own insertion
 * convention and unrelated to `table create`'s own behaviour.
 */
export function TablePanel({ onClose, controller, canvasSize, slidePath }: TablePanelProps) {
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const [locked, setLocked] = useState<{ rows: number; cols: number } | null>(null);
  const [theme, setTheme] = useState<TableTheme>("dark");
  const [header, setHeader] = useState(true);

  const previewRows = locked?.rows ?? (hover ? hover.row + 1 : 0);
  const previewCols = locked?.cols ?? (hover ? hover.col + 1 : 0);
  const canInsert = locked !== null && controller !== null && canvasSize !== null && slidePath !== null;

  async function insert(): Promise<void> {
    if (!canInsert || !locked || !canvasSize || !slidePath) return;
    await controller!.runCommand("table create", {
      slidePath,
      rows: locked.rows,
      cols: locked.cols,
      x: Math.round(canvasSize.width * 0.1),
      y: Math.round(canvasSize.height * 0.2),
      theme,
      header,
    });
    onClose();
  }

  return (
    <div className="floating-layer table-panel" role="dialog" aria-label="Table">
      <div
        className="table-panel-grid"
        role="grid"
        aria-label={`Table size${previewRows > 0 ? `：${previewRows} × ${previewCols}` : ""}`}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
          const row = Math.floor(i / GRID_COLS);
          const col = i % GRID_COLS;
          const active = row < previewRows && col < previewCols;
          return (
            <button
              key={i}
              type="button"
              className="table-panel-cell"
              data-active={active || undefined}
              aria-label={`${row + 1} × ${col + 1}`}
              onMouseEnter={() => setHover({ row, col })}
              onClick={() => setLocked({ rows: row + 1, cols: col + 1 })}
            />
          );
        })}
      </div>
      <div className="table-panel-row" role="group" aria-label="Theme">
        {THEMES.map((item) => (
          <button
            key={item.value}
            type="button"
            className="table-panel-theme"
            aria-pressed={theme === item.value}
            onClick={() => setTheme(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <label className="table-panel-row table-panel-header-toggle">
        <input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} />
        Header row
      </label>
      <button type="button" className="table-panel-insert" disabled={!canInsert} onClick={() => void insert()}>
        Insert
      </button>
    </div>
  );
}
