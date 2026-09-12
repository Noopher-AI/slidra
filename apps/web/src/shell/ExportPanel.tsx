// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";
import { Icon } from "../icons/index.js";
import { useCloseFloatingLayer } from "./use-floating-layer.js";
import type { ExportFormat } from "../live-reload.js";

/**
 * The Export dropdown's own UI state, derived by App.tsx from `export` SSE
 * events (`live-reload.ts`'s `ExportSseEvent`) — `queued` and `running` are
 * both shown with the same "exporting…" copy (an unknown/zero frame count
 * reads the same to an author as one just starting), and there is
 * deliberately no state that survives a page reload (progress resets to
 * idle on reload, since there is no job-status GET to reseed from).
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
  /** The Export button's disabled condition shares the same check as Play's canPlay ("no slides"). */
  canExport: boolean;
  state: ExportUiState;
  /** Clears the done/error strip back to idle — it has no other way out (busy clears itself via the next SSE event). */
  onDismiss(): void;
}

const EXPORT_ITEMS: ReadonlyArray<{ format: ExportFormat; tag: string; label: string; desc: string }> = [
  { format: "pdf", tag: "PDF", label: "PDF", desc: "One page per slide" },
  { format: "pdf-frames", tag: "PDF+", label: "By-frame PDF", desc: "One page per animation step" },
];

/** The Export dropdown, its two format rows, and the progress/done/error strip beneath it. */
export function ExportPanel({ open, onToggle, onClose, onPick, canExport, state, onDismiss }: ExportPanelProps) {
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
          {state.totalFrames > 0 ? `Exporting… ${state.completedFrames}/${state.totalFrames}` : "Exporting…"}
        </div>
      )}
      {state.kind === "done" && (
        <div className="export-status export-status-done">
          <a href={state.downloadPath} download onClick={onDismiss}>
            Download {state.fileName} ({state.pageCount} pages)
          </a>
          <button type="button" className="export-status-dismiss" aria-label="Close" onClick={onDismiss} />
        </div>
      )}
      {state.kind === "error" && (
        <div className="export-status export-status-error" role="alert">
          {state.message}
          <button type="button" className="export-status-dismiss" aria-label="Close" onClick={onDismiss} />
        </div>
      )}
    </div>
  );
}
