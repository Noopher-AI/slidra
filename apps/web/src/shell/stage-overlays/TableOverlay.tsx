// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type RefObject } from "react";
import type { TableModel } from "../../slide-dom.js";
import type { CanvasController, TableRuntimeEvent } from "../../canvas.js";
import {
  MIN_COL_WIDTH,
  cellRectAt,
  cellsInRange,
  columnBoundaryPositions,
  nextTableTabCell,
  rangeBoundingRect,
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
 * drag handles, and right-click menu (E2.T14/E2.T14r2, plan §4.5). The
 * range itself is NOT local state — it is owned by `canvas.ts`'s
 * `CanvasController` (plan §4.1) so the keyboard decision function
 * (`handleTableRangeKey`) and `TableSection`'s Cell block read the exact
 * same value this overlay paints; this component only mirrors it via
 * `subscribeTableRange`.
 */
export function TableOverlay({ controller, wellRef, slidePath, tableId, table }: TableOverlayProps) {
  const [cellData, setCellData] = useState<{ cells: TableCellRect[]; box: { x: number; y: number; width: number; height: number } } | null>(null);
  const [range, setRange] = useState<CellRange | null>(null);
  /** `row`/`col` address the cell whose text is edited; `atRow` is where the editor is drawn — they differ for a generated cell, which edits its hidden template row (architecture note: "double-click editing targets the template row"). */
  const [editing, setEditing] = useState<{ row: number; col: number; atRow: number; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [colDrag, setColDrag] = useState<{ col: number; widths: number[] } | null>(null);

  useEffect(() => {
    setEditing(null);
    setMenu(null);
    controller?.requestTableCells(tableId);
  }, [controller, tableId]);

  useEffect(() => {
    if (!controller) return;
    return controller.subscribeTableRange((value) => {
      setRange(value && value.tableId === tableId ? value.range : null);
    });
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
        setEditing(null);
        setMenu(null);
        return;
      }
      if (event.type === "cell-dblclick") {
        const cell = table.cells.find((c) => c.row === event.row && c.col === event.col);
        setEditing({ row: event.row, col: event.col, atRow: event.atRow, text: cell?.text ?? "" });
        setMenu(null);
        return;
      }
      if (event.type === "cell-contextmenu") {
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

  /** Screen px per table user unit — the stage zoom (and any container `scale()`) folded into one factor, so handle positions and drag distances convert both ways. */
  function pxPerUnit(box: { width: number }, cols: readonly number[]): number {
    const total = cols.reduce((sum, w) => sum + w, 0);
    return total > 0 && box.width > 0 ? box.width / total : 1;
  }

  /** `event.clientX` is viewport px, so the column's left edge is taken from the runtime's own client-px box — NOT the well-local rect the handles are painted with (mixing the two added the well's left offset to every drag). */
  function dragWidth(event: React.PointerEvent<HTMLDivElement>): number {
    const boxRect = cellData!.box;
    const k = pxPerUnit(boxRect, colDrag!.widths);
    const scaled = colDrag!.widths.map((w) => w * k);
    const startX = columnBoundaryPositions(boxRect.x, scaled)[colDrag!.col] - scaled[colDrag!.col];
    const pairTotal = colDrag!.widths[colDrag!.col] + colDrag!.widths[colDrag!.col + 1];
    // The boundary moves between the two columns it separates: neither may shrink below MIN_COL_WIDTH.
    return Math.min(Math.max((event.clientX - startX) / k, MIN_COL_WIDTH), pairTotal - MIN_COL_WIDTH);
  }

  /** Widths for the live preview: the dragged column at `width`, its right neighbour absorbing the difference (same as `table col width --keep-total`). */
  function pairedWidths(width: number): number[] {
    const delta = width - colDrag!.widths[colDrag!.col];
    return colDrag!.widths.map((w, i) => (i === colDrag!.col ? width : i === colDrag!.col + 1 ? w - delta : w));
  }

  function handleColPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!colDrag || !cellData) return;
    controller?.previewTableCols(tableId, pairedWidths(dragWidth(event)));
  }

  function handleColPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!colDrag || !cellData) return;
    const width = dragWidth(event);
    setColDrag(null);
    void run("table col width", { col: colDrag.col, width, keepTotal: true });
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
  const editRect = editing ? cellRectAt(localCells, { row: editing.atRow, col: editing.col }) : null;
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
            if (event.key === "Enter") {
              commitEdit(editing);
              return;
            }
            if (event.key === "Escape") {
              setEditing(null);
              return;
            }
            if (event.key === "Tab") {
              // F-09 (NOOP-399): commit without `setEditing(null)` — going
              // through `commitEdit` would drop `editing` to null for one
              // render, unmounting this very `<input>` and firing the
              // `onBlur` below a second time before the next cell's editor
              // remounts. Setting `editing` straight to the next cell keeps
              // the same host `<input>` across the re-render (identical JSX
              // shape, no key change), so focus never leaves it — the
              // browser default this replaces (`preventDefault()`) is
              // exactly that focus loss (see F-09's reproduction: Tab used
              // to move `document.activeElement` to the dock's hand tool).
              event.preventDefault();
              void run("table cell set", { row: editing.row, col: editing.col, text: editing.text });
              const next = nextTableTabCell(
                table.cells,
                { row: editing.atRow, col: editing.col },
                table.rows.length,
                table.cols.length,
                event.shiftKey ? -1 : 1,
              );
              if (!next) return;
              const cell = table.cells.find((c) => c.row === next.row && c.col === next.col);
              setEditing({ row: next.row, col: next.col, atRow: next.atRow, text: cell?.text ?? "" });
            }
          }}
          onBlur={() => editing && commitEdit(editing)}
        />
      )}
      {table.cols.slice(0, -1).map((_, index) => {
        const k = pxPerUnit(localBox, table.cols);
        const x = columnBoundaryPositions(localBox.x, table.cols.map((w) => w * k))[index];
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
            setEditing({ row: range.r0, col: range.c0, atRow: range.r0, text: cell?.text ?? "" });
            setMenu(null);
          }}
          onBold={() => {
            // Plan §4.5: the same toggle `handleTableRangeKey` gives ⌘B —
            // not a second, independently-written "always set 700" —
            // called directly rather than duplicated, so the menu button
            // and the shortcut can never disagree on what "Bold" means.
            controller?.handleTableRangeKey("b", { meta: true, ctrl: false, shift: false });
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
