import type { KeyboardEvent, ReactNode } from "react";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { StylePagePanel } from "./StylePagePanel.js";
import { StyleObjectPanel } from "./StyleObjectPanel.js";
import { AnimatePagePanel } from "./AnimatePagePanel.js";
import { AnimateObjectPanel } from "./AnimateObjectPanel.js";

export type SideId = "chat" | "style" | "animate";
export type SubId = "page" | "object";

export interface SidePanelProps {
  state: CanvasState;
  controller: CanvasController | null;
  /**
   * #200: Style › Page 的 Width/Height 欄位需要目前的畫布尺寸——這來自
   * `project.json`（App.tsx 的 `presentationInfo`），不在 `CanvasState`
   * 裡（`Stage.tsx` 的 `canvasSize` prop走同一份資料，同一個理由）。
   */
  canvasSize: { width: number; height: number } | null;
  /** 對話 UI（ChatPanel.tsx），原樣搬進來——App.tsx 仍然擁有它的 messages/draft 狀態，切分頁不會弄丟它。 */
  chat: ReactNode;
  /**
   * [E2.T7]/D10: 受控——App.tsx 是唯一的事實來源。Dock 的 Add animation
   * 與情境列的 Edit animation 都要能把右欄切到 Animate › Object，兩者都在
   * `Stage` 裡、`SidePanel` 在 `Stage` 外，狀態非得在共同的祖先（App.tsx）
   * 不可。有無選取的自動切換 effect 也搬到 App.tsx，這裡只負責畫面與使用
   * 者點擊/鍵盤操作。
   */
  side: SideId;
  sub: SubId;
  onSideChange(id: SideId): void;
  onSubChange(id: SubId): void;
}

const SIDE_TABS: ReadonlyArray<{ id: SideId; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "style", label: "Style" },
  { id: "animate", label: "Animate" },
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
export function SidePanel({ state, controller, canvasSize, chat, side, sub, onSideChange, onSubChange }: SidePanelProps) {
  const hasSelection = state.selection.ids.length > 0;

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
    onSideChange(next.id);
    focusSideTab(next.id);
  }

  const showSub = side === "style" || side === "animate";

  return (
    <div className="side-panel">
      <div className="side-panel-tabs" role="tablist" aria-label="Side panel">
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
            onClick={() => onSideChange(tab.id)}
            onKeyDown={(event) => handleSideKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {showSub && (
        <div className="side-panel-subtabs" role="tablist" aria-label="Page / Object">
          <button
            type="button"
            className="side-panel-subtab"
            role="tab"
            data-subtab="page"
            aria-selected={sub === "page"}
            onClick={() => onSubChange("page")}
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
            onClick={() => onSubChange("object")}
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
        {side === "style" &&
          (sub === "page" ? (
            <StylePagePanel
              pageStyle={state.pageStyle}
              backgroundImage={state.backgroundImage}
              canvasSize={canvasSize}
              controller={controller}
            />
          ) : (
            <StyleObjectPanel state={state} controller={controller} />
          ))}
        {side === "animate" &&
          (sub === "page" ? (
            <AnimatePagePanel state={state} controller={controller} />
          ) : (
            <AnimateObjectPanel state={state} controller={controller} />
          ))}
      </div>
    </div>
  );
}
