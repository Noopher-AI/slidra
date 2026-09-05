import { useRef } from "react";
import { Icon } from "../icons/index.js";
import { useCloseFloatingLayer } from "./use-floating-layer.js";
import type { ExportFormat } from "../live-reload.js";

/**
 * The Export dropdown's own UI state (NOOP-93 §4.7's table), derived by
 * App.tsx from `export` SSE events (`live-reload.ts`'s `ExportSseEvent`) —
 * `queued` and `running` are both shown as "匯出中…" (an unknown/zero
 * frame count reads the same to an author as one just starting), and there
 * is deliberately no state that survives a page reload (§4.7's last row:
 * "重新整理頁面後 → 進度狀態消失", no job-status GET to reseed from).
 */
export type ExportUiState =
  | { kind: "idle" }
  | { kind: "busy"; format: ExportFormat; completedFrames: number; totalFrames: number }
  | { kind: "done"; fileName: string; pageCount: number; downloadPath: string }
  | { kind: "error"; message: string };

export interface ExportPanelProps {
  open: boolean;
  onToggle(): void;
  onClose(): void;
  onPick(format: ExportFormat): void;
  /** Export 按鈕的停用條件與 Play 的 canPlay 共用同一個判斷（§4.7：「沒有投影片」）。 */
  canExport: boolean;
  state: ExportUiState;
}

const EXPORT_ITEMS: ReadonlyArray<{ format: ExportFormat; tag: string; label: string; desc: string }> = [
  { format: "pdf", tag: "PDF", label: "PDF", desc: "One page per slide" },
  { format: "pdf-frames", tag: "PDF+", label: "By-frame PDF", desc: "One page per animation step" },
];

/** NOOP-93 §4.7 — the Export dropdown, its two format rows, and the progress/done/error strip beneath it. */
export function ExportPanel({ open, onToggle, onClose, onPick, canExport, state }: ExportPanelProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useCloseFloatingLayer(open, [menuRef, buttonRef], onClose);

  const busy = state.kind === "busy";

  return (
    <div className="export-panel-anchor">
      <button
        ref={buttonRef}
        type="button"
        className="titlebar-button export-toggle-button"
        title="Export"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!canExport}
        onClick={onToggle}
      >
        <Icon name="export" size="inline" />
        Export
      </button>
      {open && (
        <div ref={menuRef} role="menu" className="export-menu">
          <div className="export-menu-heading">Export as</div>
          {EXPORT_ITEMS.map((item) => (
            <button
              key={item.format}
              type="button"
              role="menuitem"
              className="export-menu-item"
              disabled={busy}
              onClick={() => onPick(item.format)}
            >
              <span className={`export-menu-tag export-menu-tag-${item.format}`}>{item.tag}</span>
              <span className="export-menu-item-text">
                <span className="export-menu-item-label">{item.label}</span>
                <span className="export-menu-item-desc">{item.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {state.kind === "busy" && (
        <div className="export-status" role="status">
          {state.totalFrames > 0 ? `匯出中… ${state.completedFrames}/${state.totalFrames}` : "匯出中…"}
        </div>
      )}
      {state.kind === "done" && (
        <div className="export-status export-status-done">
          <a href={state.downloadPath} download>
            下載 {state.fileName}（{state.pageCount} 頁）
          </a>
        </div>
      )}
      {state.kind === "error" && (
        <div className="export-status export-status-error" role="alert">
          {state.message}
        </div>
      )}
    </div>
  );
}
