import type { RefObject } from "react";

export interface ThumbContextMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  /** Anchor position — the cursor's clientX/clientY at the triggering contextmenu event. */
  x: number;
  y: number;
  /** 0-based index of the slide this menu was opened on. */
  index: number;
  slideCount: number;
  onNewBelow: () => void;
  onOutline: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

/**
 * 縮圖右鍵選單（T3 plan §3.9 的原型項目順序）。留言鈕與「Comment to
 * agent」一律 `disabled`＋`aria-disabled`——入口已備好，執行在 F13（§2 邊
 * 界 2），不接受送聊天訊息或假裝成功的替代方案。
 */
export function ThumbContextMenu({
  menuRef,
  x,
  y,
  index,
  slideCount,
  onNewBelow,
  onOutline,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onDelete,
}: ThumbContextMenuProps) {
  return (
    <div
      ref={menuRef}
      className="thumb-context-menu"
      role="menu"
      data-testid="thumb-context-menu"
      style={{ position: "fixed", left: x, top: y }}
    >
      <button type="button" role="menuitem" className="rail-menu-item" onClick={onNewBelow}>
        New slide below
      </button>
      <button type="button" role="menuitem" className="rail-menu-item" onClick={onOutline}>
        New slides from outline…
      </button>
      <button type="button" role="menuitem" className="rail-menu-item" onClick={onDuplicate}>
        Duplicate slide <span className="thumb-context-menu-key">⌘D</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="rail-menu-item"
        aria-label="Comment to agent"
        aria-disabled="true"
        disabled
      >
        Comment to agent
      </button>
      <div className="thumb-context-menu-divider" />
      <button type="button" role="menuitem" className="rail-menu-item" disabled={index === 0} onClick={onMoveUp}>
        Move up
      </button>
      <button
        type="button"
        role="menuitem"
        className="rail-menu-item"
        disabled={index === slideCount - 1}
        onClick={onMoveDown}
      >
        Move down
      </button>
      <div className="thumb-context-menu-divider" />
      <button type="button" role="menuitem" className="rail-menu-item thumb-context-menu-delete" onClick={onDelete}>
        Delete slide
      </button>
    </div>
  );
}
