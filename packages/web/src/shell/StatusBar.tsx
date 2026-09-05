import type { CanvasController, CanvasState } from "../canvas.js";
import { Icon } from "../icons/index.js";

export interface StatusBarProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/**
 * 狀態列 (New v3 skeleton)：02-DESIGN_DOC.md §3 只列「selection chip, 快捷鍵
 * 提示, 頁碼」——舊殼的標準／網格／播放三顆檢視切換按鈕已經沒有對應物：網格
 * 檢視整個拿掉（GridView 已刪除），播放改由 TitleBar 的 ▶Play 進入（見
 * TitleBar.tsx）。‹ › 翻頁鈕與選取名稱沿用舊殼既有的 class/aria-label 契約
 * （selection.test.ts / direct-manipulation.test.ts / locked-element.test.ts
 * 測的是 canvas.ts/iframe-runtime 本身的選取語意，這裡只換了外層容器的
 * class 名稱，不動計算邏輯）。
 */
export function StatusBar({ state, controller }: StatusBarProps) {
  const slideCount = state.slides.length;
  const hasSlides = slideCount > 0;

  // #56 (ADR-0011)：顯示 data-comot-name（若有）否則退回 id；多選顯示個數，
  // 邏輯逐字保留自舊 StatusBar.tsx，只是容器 class 換了名字。
  const selectionCount = state.selection.ids.length;
  const selectionLabel =
    selectionCount === 0
      ? null
      : selectionCount === 1
        ? (state.selection.names[0] ?? state.selection.ids[0])
        : `${selectionCount} elements`;

  return (
    <footer className="status status-bar">
      <span className="status-selection-chip">{selectionLabel !== null && <>Selected: <b>{selectionLabel}</b></>}</span>
      <span className="status-hints">
        ← → slides · ⇧click multi-select · double-click to edit · ⌘Z undo · ⌘D duplicate · right-click for more
      </span>
      <span className="spacer" />
      <span className="status-page">
        <button
          type="button"
          className="slide-nav-button"
          aria-label="Previous slide"
          disabled={!hasSlides || state.currentIndex <= 0}
          onClick={() => void controller?.previous()}
        >
          <Icon name="prev" size="inline" />
        </button>
        <span className="slide-nav-position">
          {hasSlides ? (
            <>
              Slide <b>{state.currentIndex + 1}</b> of {slideCount}
            </>
          ) : (
            "No slides"
          )}
        </span>
        <button
          type="button"
          className="slide-nav-button"
          aria-label="Next slide"
          disabled={!hasSlides || state.currentIndex >= slideCount - 1}
          onClick={() => void controller?.next()}
        >
          <Icon name="next" size="inline" />
        </button>
      </span>
    </footer>
  );
}
