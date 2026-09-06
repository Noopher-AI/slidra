import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../icons/index.js";
import { useCloseFloatingLayer } from "./use-floating-layer.js";
import { NewMenu } from "./rail/NewMenu.js";
import { TemplatesMenu } from "./rail/TemplatesMenu.js";
import { ThumbContextMenu } from "./rail/ThumbContextMenu.js";
import { OutlineModal } from "./rail/OutlineModal.js";
import type { TemplateEntry } from "./rail/useTemplateList.js";

type CommandResult = { ok: boolean; message: string; data?: unknown };
type RunCommand = (name: string, input: Record<string, unknown>) => Promise<CommandResult | undefined>;
type RunPageCommand = (name: string, input: Record<string, unknown>, targetIndex: number | null) => Promise<CommandResult | undefined>;

export interface ThumbContextMenuRequest {
  index: number;
  x: number;
  y: number;
}

export interface RailProps {
  /** overview.ts 掛載用的容器。App 只掛一次，React 不再渲染其內容(ADR-0001/0002)。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 「Slides」標題右側的頁數（原型：`SLIDES 7`）。 */
  slideCount: number;
  /** project.json 的 slides 順序——右鍵選單的 Duplicate/Move/Delete 需要目標頁的虛擬路徑。 */
  slides: readonly string[];
  currentIndex: number;
  runCommand: RunCommand;
  runPageCommand: RunPageCommand;
  /** overview.ts 的縮圖右鍵事件，掛載在 App.tsx（見它自己的 mountOverview hooks 注解）。 */
  contextMenuRequest: ThumbContextMenuRequest | null;
  onCloseContextMenu: () => void;
}

type RailMenu = "new" | "templates" | null;

/**
 * 左欄（T3 [E2.T3]）：New/Templates 按鈕 + 縮圖 rail。`overview.ts`（既有
 * 的 vanilla DOM 模組）繼續掛在 `.overview` 節點裡，class 名稱刻意保留。
 *
 * New／Templates／縮圖右鍵選單三個浮層互斥（02-DESIGN_DOC.md §4.3）：任一
 * 開啟時關掉其他，一律用既有的 `useCloseFloatingLayer`，不自己寫第二套
 * outside-click。
 */
export function Rail({
  containerRef,
  slideCount,
  slides,
  currentIndex,
  runCommand,
  runPageCommand,
  contextMenuRequest,
  onCloseContextMenu,
}: RailProps) {
  const [menu, setMenu] = useState<RailMenu>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const templatesButtonRef = useRef<HTMLButtonElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useCloseFloatingLayer(menu !== null, [menuRef, newButtonRef, templatesButtonRef], () => setMenu(null));
  useCloseFloatingLayer(contextMenuRequest !== null, [contextMenuRef], onCloseContextMenu);

  // 浮層互斥（02-DESIGN_DOC.md §4.3）：縮圖右鍵選單一開，New/Templates 選單跟著關。
  useEffect(() => {
    if (contextMenuRequest !== null) setMenu(null);
  }, [contextMenuRequest]);

  const hasSlides = slideCount > 0;
  const insertAt = hasSlides ? currentIndex + 1 : 0;

  function openMenu(next: Exclude<RailMenu, null>): void {
    onCloseContextMenu();
    setMenu((current) => (current === next ? null : next));
  }

  function addSlideAt(at: number, templatePath?: string): void {
    const input: Record<string, unknown> = { at };
    if (templatePath) input.templatePath = templatePath;
    void runPageCommand("slide add", input, at);
  }

  function onSelectBlank(): void {
    addSlideAt(insertAt);
    setMenu(null);
  }

  function onSelectTemplate(entry: TemplateEntry): void {
    addSlideAt(insertAt, entry.file);
    setMenu(null);
  }

  function onOpenOutline(): void {
    setMenu(null);
    onCloseContextMenu();
    setOutlineOpen(true);
  }

  function contextMenuHandlers(index: number) {
    return {
      onNewBelow: () => {
        addSlideAt(index + 1);
        onCloseContextMenu();
      },
      onOutline: () => {
        onCloseContextMenu();
        setOutlineOpen(true);
      },
      onDuplicate: () => {
        void runPageCommand("slide duplicate", { slidePath: slides[index] }, index + 1);
        onCloseContextMenu();
      },
      onMoveUp: () => {
        if (index === 0) return;
        void runPageCommand("slide move", { slidePath: slides[index], newIndex: index - 1 }, index - 1);
        onCloseContextMenu();
      },
      onMoveDown: () => {
        if (index === slideCount - 1) return;
        void runPageCommand("slide move", { slidePath: slides[index], newIndex: index + 1 }, index + 1);
        onCloseContextMenu();
      },
      onDelete: () => {
        const newLength = slideCount - 1;
        void runPageCommand("slide delete", { slidePath: slides[index] }, newLength === 0 ? null : Math.min(index, newLength - 1));
        onCloseContextMenu();
      },
    };
  }

  return (
    <aside className="rail">
      <div className="rail-actions">
        <button
          ref={newButtonRef}
          type="button"
          className="rail-action-button"
          aria-expanded={menu === "new"}
          onClick={() => openMenu("new")}
        >
          <Icon name="plus" size="inline" />
          New
        </button>
        <button
          ref={templatesButtonRef}
          type="button"
          className="rail-action-button"
          aria-expanded={menu === "templates"}
          onClick={() => openMenu("templates")}
        >
          <Icon name="template" size="inline" />
          Templates
        </button>
        {menu === "new" && (
          <NewMenu
            menuRef={menuRef}
            runCommand={runCommand}
            onSelectBlank={onSelectBlank}
            onSelectTemplate={onSelectTemplate}
            onOpenOutline={onOpenOutline}
          />
        )}
        {menu === "templates" && (
          <TemplatesMenu menuRef={menuRef} runCommand={runCommand} onSelectTemplate={onSelectTemplate} />
        )}
      </div>
      <div className="rail-slides-label">
        Slides
        <span className="rail-slides-count">{slideCount}</span>
      </div>
      <aside className="overview" ref={containerRef} />
      {contextMenuRequest && (
        <ThumbContextMenu
          menuRef={contextMenuRef}
          x={contextMenuRequest.x}
          y={contextMenuRequest.y}
          index={contextMenuRequest.index}
          slideCount={slideCount}
          {...contextMenuHandlers(contextMenuRequest.index)}
        />
      )}
      {outlineOpen && <OutlineModal onClose={() => setOutlineOpen(false)} />}
    </aside>
  );
}
