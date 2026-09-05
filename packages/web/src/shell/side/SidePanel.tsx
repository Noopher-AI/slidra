import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasState } from "../../canvas.js";
import { StylePagePanel } from "./StylePagePanel.js";
import { StyleObjectPanel } from "./StyleObjectPanel.js";
import { AnimatePagePanel } from "./AnimatePagePanel.js";
import { AnimateObjectPanel } from "./AnimateObjectPanel.js";

export interface SidePanelProps {
  state: CanvasState;
  /** 對話 UI（ChatPanel.tsx），原樣搬進來——App.tsx 仍然擁有它的 messages/draft 狀態，切分頁不會弄丟它。 */
  chat: ReactNode;
}

type SideId = "chat" | "style" | "animate";
type SubId = "page" | "object";

const SIDE_TABS: ReadonlyArray<{ id: SideId; label: string }> = [
  { id: "chat", label: "對話" },
  { id: "style", label: "樣式" },
  { id: "animate", label: "動畫" },
];

/**
 * 右欄 (New v3 skeleton)：3 個主分頁（對話／樣式／動畫）+ 樣式/動畫底下的
 * Page/Object 子分頁狀態機（02-DESIGN_DOC.md §4.4）。
 *
 * 子分頁的自動切換只鎖在「有無選取」這個布林值上（`hasSelection` 的
 * effect），不是鎖在「目前是不是 style/animate」——這樣不管使用者當下停
 * 在哪個主分頁，選取變化都會先把子分頁狀態準備好；使用者切到 style/
 * animate 時看到的已經是正確的子分頁，不需要額外一次判斷「切分頁當下有沒
 * 有選取」。這正是規格「有選取時自動切 object；無選取時 disabled 並自動回
 * page」的字面意思——沒有限定「僅在已經停在 style/animate 時才生效」。
 * 主分頁（`side`）永遠不會被這個 effect 動到：規格明講「changing selection
 * while side=chat 不自動切 side」，這裡索性讓 side 完全只受使用者點擊控制。
 */
export function SidePanel({ state, chat }: SidePanelProps) {
  const [side, setSide] = useState<SideId>("chat");
  const [sub, setSub] = useState<SubId>("page");
  const hasSelection = state.selection.ids.length > 0;

  useEffect(() => {
    setSub(hasSelection ? "object" : "page");
  }, [hasSelection]);

  function focusSideTab(id: SideId): void {
    document.getElementById(`side-panel-tab-${id}`)?.focus();
  }

  function handleSideKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % SIDE_TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + SIDE_TABS.length) % SIDE_TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SIDE_TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = SIDE_TABS[nextIndex];
    setSide(next.id);
    focusSideTab(next.id);
  }

  const showSub = side === "style" || side === "animate";

  return (
    <div className="side-panel">
      <div className="side-panel-tabs" role="tablist" aria-label="右欄">
        {SIDE_TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            id={`side-panel-tab-${tab.id}`}
            className="side-panel-tab"
            role="tab"
            data-tab={tab.id}
            aria-selected={side === tab.id}
            aria-controls={`side-panel-panel-${tab.id}`}
            tabIndex={side === tab.id ? 0 : -1}
            onClick={() => setSide(tab.id)}
            onKeyDown={(event) => handleSideKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {showSub && (
        <div className="side-panel-subtabs" role="tablist" aria-label="頁面／物件">
          <button
            type="button"
            className="side-panel-subtab"
            role="tab"
            data-subtab="page"
            aria-selected={sub === "page"}
            onClick={() => setSub("page")}
          >
            Page
          </button>
          <button
            type="button"
            className="side-panel-subtab"
            role="tab"
            data-subtab="object"
            aria-selected={sub === "object"}
            disabled={!hasSelection}
            onClick={() => setSub("object")}
          >
            Object
          </button>
        </div>
      )}
      <div
        className="side-panel-tabpanel"
        role="tabpanel"
        id={`side-panel-panel-${side}`}
        aria-labelledby={`side-panel-tab-${side}`}
      >
        {side === "chat" && chat}
        {side === "style" && (sub === "page" ? <StylePagePanel /> : <StyleObjectPanel />)}
        {side === "animate" && (sub === "page" ? <AnimatePagePanel /> : <AnimateObjectPanel />)}
      </div>
    </div>
  );
}
