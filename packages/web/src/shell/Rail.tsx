import { useRef, useState, type RefObject } from "react";
import { Icon } from "../icons/index.js";
import { useCloseFloatingLayer } from "./use-floating-layer.js";

export interface RailProps {
  /** overview.ts 掛載用的容器。App 只掛一次，React 不再渲染其內容（ADR-0001/0002）。 */
  containerRef: RefObject<HTMLElement | null>;
}

type RailMenu = "new" | "templates" | null;

/**
 * 左欄 (New v3 skeleton)：New/Templates 按鈕 + 縮圖 rail。02-DESIGN_DOC.md
 * §7 的「從大綱生成」「範本清單」內容不在這張骨架票範圍內（Insert 面板同一
 * 類的「未來票」內容）——兩顆按鈕只開關一個空的浮層容器，不渲染清單。
 * `overview.ts`（既有的 vanilla DOM 模組）繼續掛在 `.overview` 節點裡，
 * class 名稱刻意保留，Rail 本身只是多包一層版面容器。
 */
export function Rail({ containerRef }: RailProps) {
  const [menu, setMenu] = useState<RailMenu>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const templatesButtonRef = useRef<HTMLButtonElement | null>(null);

  useCloseFloatingLayer(menu !== null, [menuRef, newButtonRef, templatesButtonRef], () => setMenu(null));

  return (
    <aside className="rail">
      <div className="rail-actions">
        <button
          ref={newButtonRef}
          type="button"
          className="rail-action-button"
          aria-expanded={menu === "new"}
          onClick={() => setMenu((current) => (current === "new" ? null : "new"))}
        >
          <Icon name="plus" size="inline" />
          New
        </button>
        <button
          ref={templatesButtonRef}
          type="button"
          className="rail-action-button"
          aria-expanded={menu === "templates"}
          onClick={() => setMenu((current) => (current === "templates" ? null : "templates"))}
        >
          <Icon name="template" size="inline" />
          Templates
        </button>
        {menu !== null && <div ref={menuRef} className="rail-menu" role="menu" data-menu={menu} />}
      </div>
      <div className="rail-slides-label">Slides</div>
      <aside className="overview" ref={containerRef} />
    </aside>
  );
}
