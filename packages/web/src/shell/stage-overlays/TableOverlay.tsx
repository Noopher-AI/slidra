import { useEffect, useRef, useState, type RefObject } from "react";
import type { TableModel } from "@co-motion/core";
import type { CanvasController, TableRuntimeEvent } from "../../canvas.js";
import {
  cellRectAt,
  cellsInRange,
  columnBoundaryPositions,
  isCellInRange,
  normalizeRange,
  rangeBoundingRect,
  type CellAddress,
  type CellRange,
  type TableCellRect,
} from "../../table-overlay.js";
import { toLocalRect } from "./OverlayLayer.js";
import { useCloseFloatingLayer } from "../use-floating-layer.js";
import { TableCellMenu } from "./TableCellMenu.js";

export interface TableOverlayProps {
  controller: CanvasController | null;
  wellRef: RefObject<HTMLDivElement | null>;
  slidePath: string | null;
  tableId: string;
  table: TableModel;
}

/**
 * The selected table's own cell-range highlight, cell editor, column-width
 * drag handles, and right-click menu (E2.T14, plan §4.5). Self-contained
 * inside `OverlayLayer` — it asks the runtime for this one table's cell
 * rects (`requestTableCells`) and reacts to `subscribeTable`'s hit reports,
 * without any new prop threaded through `Stage.tsx`/`App.tsx`.
 *
 * NOT implemented this round (see the PR's "不確定與保留事項"): Tab/⇧Tab
 * cell navigation, Esc-to-exit-range, and Delete/⌘B as keyboard shortcuts
 * while a range is active. Those need to pre-empt `App.tsx`'s existing
 * document-level Delete/undo-redo keydown handler, which this
 * self-contained component has no reach into without lifting range state
 * to a shared ancestor — a larger change deferred rather than rushed.
 * Bold remains reachable via the cell context menu's own button.
 */
export function TableOverlay({ controller, wellRef, slidePath, tableId, table }: TableOverlayProps) {
  const [cellData, setCellData] = useState<{ cells: TableCellRect[]; box: { x: number; y: number; width: number; height: number } } | null>(null);
  const [range, setRange] = useState<CellRange | null>(null);
  const anchorRef = useRef<CellAddress | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [colDrag, setColDrag] = useState<{ col: number; widths: number[] } | null>(null);

  useEffect(() => {
    setRange(null);
    setEditing(null);
    setMenu(null);
    anchorRef.current = null;
    controller?.requestTableCells(tableId);
  }, [controller, tableId]);

  useEffect(() => {
    if (!controller) return;
    return controller.subscribeTable((event: TableRuntimeEvent) => {
      if (event.id !== tableId) return;
      if (event.type === "cells") {
        setCellData({ cells: event.cells, box: event.box });
        return;
      }
      if (event.type === "cell-click") {
        if (event.additive && anchorRef.current) {
          setRange(normalizeRange(anchorRef.current, { row: event.row, col: event.col }));
        } else {
          anchorRef.current = { row: event.row, col: event.col };
          setRange({ r0: event.row, c0: event.col, r1: event.row, c1: event.col });
        }
        setEditing(null);
        setMenu(null);
        return;
      }
      if (event.type === "cell-dblclick") {
        const cell = table.cells.find((c) => c.row === event.row && c.col === event.col);
        setEditing({ row: event.row, col: event.col, text: cell?.text ?? "" });
        setMenu(null);
        return;
      }
      if (event.type === "cell-contextmenu") {
        const cell = { row: event.row, col: event.col };
        anchorRef.current = cell;
        setRange((current) => (current && isCellInRange(cell, current) ? current : { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col }));
        setMenu({ x: event.x, y: event.y });
      }
    });
  }, [controller, tableId, table]);

  useCloseFloatingLayer(menu !== null, [menuRef], () => setMenu(null));

  async function run(name: string, input: Record<string, unknown>): Promise<void> {
    if (!controller || !slidePath) return;
    await controller.runCommand(name, { slidePath, elementId: tableId, ...input });
    controller.requestTableCells(tableId);
  }

  function commitEdit(next: { row: number; col: number; text: string }): void {
    void run("table cell set", { row: next.row, col: next.col, text: next.text });
    setEditing(null);
  }

  function topLeftCell(r: CellRange) {
    return table.cells.find((c) => c.row === r.r0 && c.col === r.c0);
  }

  function handleColPointerDown(col: number, event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    (event.target as Element).setPointerCapture(event.pointerId);
    setColDrag({ col, widths: [...table.cols] });
  }

  function handleColPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!colDrag || !cellData) return;
    const boxRect = toLocalRect(cellData.box, wellOffset());
    const startX = columnBoundaryPositions(boxRect.x, colDrag.widths)[colDrag.col] - colDrag.widths[colDrag.col];
    const width = Math.max(1, event.clientX - startX);
    const nextWidths = colDrag.widths.map((w, i) => (i === colDrag.col ? width : w));
    controller?.previewTableCols(tableId, nextWidths);
  }

  function handleColPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!colDrag || !cellData) return;
    const boxRect = toLocalRect(cellData.box, wellOffset());
    const startX = columnBoundaryPositions(boxRect.x, colDrag.widths)[colDrag.col] - colDrag.widths[colDrag.col];
    const width = Math.max(1, event.clientX - startX);
    setColDrag(null);
    void run("table col width", { col: colDrag.col, width });
  }

  function wellOffset(): { x: number; y: number } {
    const wellRect = wellRef.current?.getBoundingClientRect();
    return { x: wellRect?.left ?? 0, y: wellRect?.top ?? 0 };
  }

  if (!cellData) return null;

  const offset = wellOffset();
  const localCells: TableCellRect[] = cellData.cells.map((cell) => ({ ...cell, rect: toLocalRect(cell.rect, offset) }));
  const localBox = toLocalRect(cellData.box, offset);
  const rangeRect = range ? rangeBoundingRect(localCells, range) : null;
  const editRect = editing ? cellRectAt(localCells, editing) : null;
  const topLeft = range ? topLeftCell(range) : undefined;
  const canMerge = range ? range.r1 > range.r0 || range.c1 > range.c0 : false;
  const canUnmerge = topLeft ? topLeft.rowSpan > 1 || topLeft.colSpan > 1 : false;

  return (
    <>
      {rangeRect && (
        <div
          className="table-range-box"
          style={{ position: "absolute", left: rangeRect.x, top: rangeRect.y, width: rangeRect.width, height: rangeRect.height }}
        />
      )}
      {editing && editRect && (
        <input
          autoFocus
          className="table-cell-editor"
          style={{ position: "absolute", left: editRect.x, top: editRect.y, width: editRect.width, height: editRect.height }}
          value={editing.text}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitEdit(editing);
            if (event.key === "Escape") setEditing(null);
          }}
          onBlur={() => editing && commitEdit(editing)}
        />
      )}
      {table.cols.slice(0, -1).map((_, index) => {
        const x = columnBoundaryPositions(localBox.x, table.cols)[index];
        return (
          <div
            key={index}
            className="table-col-handle"
            style={{ position: "absolute", left: x - 2, top: localBox.y, height: localBox.height }}
            onPointerDown={(event) => handleColPointerDown(index, event)}
            onPointerMove={handleColPointerMove}
            onPointerUp={handleColPointerUp}
          />
        );
      })}
      {menu && range && (
        <TableCellMenu
          menuRef={menuRef}
          x={menu.x}
          y={menu.y}
          canMerge={canMerge}
          canUnmerge={canUnmerge}
          onEdit={() => {
            const cell = topLeftCell(range);
            setEditing({ row: range.r0, col: range.c0, text: cell?.text ?? "" });
            setMenu(null);
          }}
          onBold={() => {
            void run("table cell style set", { row: range.r0, col: range.c0, rowEnd: range.r1, colEnd: range.c1, attr: "font-weight", value: "700" });
            setMenu(null);
          }}
          onInsertRowAbove={() => {
            void run("table row insert", { at: range.r0 });
            setMenu(null);
          }}
          onInsertRowBelow={() => {
            void run("table row insert", { at: range.r1 + 1 });
            setMenu(null);
          }}
          onInsertColLeft={() => {
            void run("table col insert", { at: range.c0 });
            setMenu(null);
          }}
          onInsertColRight={() => {
            void run("table col insert", { at: range.c1 + 1 });
            setMenu(null);
          }}
          onMerge={() => {
            void run("table merge", { row: range.r0, col: range.c0, rowSpan: range.r1 - range.r0 + 1, colSpan: range.c1 - range.c0 + 1 });
            setMenu(null);
          }}
          onUnmerge={() => {
            void run("table merge", { row: range.r0, col: range.c0, unmerge: true });
            setMenu(null);
          }}
          onDeleteRow={() => {
            void run("table row delete", { at: range.r0 });
            setMenu(null);
          }}
          onDeleteCol={() => {
            void run("table col delete", { at: range.c0 });
            setMenu(null);
          }}
          onClear={() => {
            for (const cell of cellsInRange(range)) void run("table cell set", { row: cell.row, col: cell.col, text: "" });
            setMenu(null);
          }}
        />
      )}
    </>
  );
}
