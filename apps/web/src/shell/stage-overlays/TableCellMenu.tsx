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
 * 儲存格右鍵選單（E2.T14, plan §4.5, docs/design/docs/05-INTERACTIONS.feature
 * 「表格儲存格」）：Edit／Bold／插列插欄／合併或取消合併／刪列刪欄／Clear。
 * 同 `ThumbContextMenu.tsx` 的形狀——`position: fixed` 錨定在觸發右鍵的座
 * 標，父層用 `useCloseFloatingLayer` 管開關。
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
