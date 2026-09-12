import type { RefObject } from "react";

export interface TableCellMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  /** The current range covers more than one cell. */
  canMerge: boolean;
  /** The range's top-left cell is already part of a merge. */
  canUnmerge: boolean;
  onEdit(): void;
  onBold(): void;
  onInsertRowAbove(): void;
  onInsertRowBelow(): void;
  onInsertColLeft(): void;
  onInsertColRight(): void;
  onMerge(): void;
  onUnmerge(): void;
  onDeleteRow(): void;
  onDeleteCol(): void;
  onClear(): void;
}

/**
 * The table cell's right-click menu: Edit/Bold/insert row or column/merge
 * or unmerge/delete row or column/Clear. Shaped the same way as
 * `ThumbContextMenu.tsx` — `position: fixed` anchored at the right-click's
 * coordinates, with the parent using `useCloseFloatingLayer` to manage
 * open/close.
 */
export function TableCellMenu({
  menuRef,
  x,
  y,
  canMerge,
  canUnmerge,
  onEdit,
  onBold,
  onInsertRowAbove,
  onInsertRowBelow,
  onInsertColLeft,
  onInsertColRight,
  onMerge,
  onUnmerge,
  onDeleteRow,
  onDeleteCol,
  onClear,
}: TableCellMenuProps) {
  return (
    <div
      ref={menuRef}
      className="table-cell-menu"
      role="menu"
      data-testid="table-cell-menu"
      style={{ position: "fixed", left: x, top: y }}
    >
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onEdit}>
        Edit
      </button>
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onBold}>
        Bold
      </button>
      <div className="table-cell-menu-divider" />
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onInsertRowAbove}>
        Insert row above
      </button>
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onInsertRowBelow}>
        Insert row below
      </button>
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onInsertColLeft}>
        Insert column left
      </button>
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onInsertColRight}>
        Insert column right
      </button>
      <div className="table-cell-menu-divider" />
      {canMerge && (
        <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onMerge}>
          Merge cells
        </button>
      )}
      {canUnmerge && (
        <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onUnmerge}>
          Unmerge
        </button>
      )}
      <div className="table-cell-menu-divider" />
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onDeleteRow}>
        Delete row
      </button>
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onDeleteCol}>
        Delete column
      </button>
      <div className="table-cell-menu-divider" />
      <button type="button" role="menuitem" className="table-cell-menu-item" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
