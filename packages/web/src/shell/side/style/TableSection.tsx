import type { CanvasController, CanvasState } from "../../../canvas.js";

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

/**
 * Style › Object's table section (E2.T14, plan §0(b)/§5 E12): theme/header
 * toggles, and — only for a bound table — the source path plus a Refresh
 * button. `StyleObjectPanel.tsx` renders this in place of its own empty
 * container exactly when the current selection is a single table.
 *
 * Cell-range style controls (align/fill/text-fill on the current cell
 * selection) are NOT in this section — that range lives in the stage
 * overlay's own local state, which this panel has no access to without a
 * new piece of state lifted to a shared ancestor (App.tsx). Out of scope
 * for this round; see the PR's "不確定與保留事項". `table cell style set`
 * remains reachable via the CLI and the cell context menu.
 */
export function TableSection({ state, controller, elementId, theme, header, source }: TableSectionProps) {
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;

  async function run(name: string, input: Record<string, unknown>): Promise<void> {
    if (!controller || !slidePath) return;
    await controller.runCommand(name, { slidePath, elementId, ...input });
  }

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
