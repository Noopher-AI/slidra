import type { CanvasController, CanvasState } from "../canvas.js";
import type { ShellView } from "./view.js";

// Icons are hand-drawn in this repo (traced from docs/design/base-shell.html); no third-party icon art.

export interface StatusBarProps {
  state: CanvasState;
  controller: CanvasController | null;
  view: ShellView;
  onViewChange(view: ShellView): void;
  /**
   * 離開播放必須走 App 的 handleExitPlay：它會先等待 in-flight 的
   * requestFullscreen 落地、再問瀏覽器真正的 fullscreenElement。
   * 直接呼叫 controller.exitPlay() 會退掉 #29 behaviour contract 第四列。
   * StatusBar 本身在 mode === "play" 時不會被渲染（見 App.tsx 的 1.8 決定），
   * 這個 prop 只在按下「標準」view-btn 那一瞬間、canvasState 尚未來得及讓
   * App 卸載這個元件之前防禦性地成立——保留它是為了不讓「標準」鈕在極端
   * 時序下呼叫一個已經過期的 exitPlay 邏輯之外的東西。
   */
  onExitPlay(): void;
}

/**
 * 狀態列 (#53). ‹ › paging buttons stay here even though base-shell.html's
 * own status bar has none — see the PR body's "deviation from the
 * baseline" note. Class names and aria-labels are the pre-existing
 * `.slide-nav-button` contract (#25/#29's e2e suite), moved verbatim.
 */
export function StatusBar({ state, controller, view, onViewChange, onExitPlay }: StatusBarProps) {
  const slideCount = state.slides.length;
  const hasSlides = slideCount > 0;

  function handleViewClick(next: ShellView | "play"): void {
    if (next === "play") {
      void controller?.play();
      return;
    }
    // Defensive only (see the prop's own comment above): mode should
    // already be "view" whenever this button is reachable at all.
    if (state.mode === "play") {
      onExitPlay();
      return;
    }
    onViewChange(next);
  }

  // #56 (ADR-0011): 顯示名稱 (data-comot-name) when the selected element
  // carries one, its 識別碼 (id) otherwise — that fallback mapping is a
  // view-layer decision, not something canvas.ts's CanvasState encodes.
  const selectionLabel = state.selection ? (state.selection.name ?? state.selection.id) : null;

  return (
    <footer className="status status-bar">
      <span className="sel-name">{selectionLabel !== null && <>已選取：<b>{selectionLabel}</b></>}</span>
      <span className="spacer" />
      <span className="slide-nav-position">
        {hasSlides ? `第 ${state.currentIndex + 1} 頁，共 ${slideCount} 頁` : "尚無投影片"}
      </span>
      <button
        type="button"
        className="slide-nav-button"
        aria-label="上一頁"
        disabled={!hasSlides || state.currentIndex <= 0}
        onClick={() => void controller?.previous()}
      >
        ‹
      </button>
      <button
        type="button"
        className="slide-nav-button"
        aria-label="下一頁"
        disabled={!hasSlides || state.currentIndex >= slideCount - 1}
        onClick={() => void controller?.next()}
      >
        ›
      </button>
      <div className="views">
        <button
          type="button"
          className="view-btn"
          data-view="normal"
          aria-pressed={view === "normal"}
          title="標準"
          onClick={() => handleViewClick("normal")}
        >
          <svg viewBox="0 0 16 16">
            <rect x="1.5" y="2.5" width="4" height="11" />
            <rect x="7.5" y="2.5" width="7" height="11" />
          </svg>
        </button>
        <button
          type="button"
          className="view-btn"
          data-view="grid"
          aria-pressed={view === "grid"}
          title="總覽網格"
          onClick={() => handleViewClick("grid")}
        >
          <svg viewBox="0 0 16 16">
            <rect x="1.5" y="2.5" width="5.5" height="4.5" />
            <rect x="9" y="2.5" width="5.5" height="4.5" />
            <rect x="1.5" y="9" width="5.5" height="4.5" />
            <rect x="9" y="9" width="5.5" height="4.5" />
          </svg>
        </button>
        <button
          type="button"
          className="view-btn"
          data-view="play"
          aria-pressed={false}
          title="播放"
          disabled={!hasSlides}
          onClick={() => handleViewClick("play")}
        >
          <svg viewBox="0 0 16 16">
            <path d="M4 2.5 L13 8 L4 13.5 Z" />
          </svg>
        </button>
      </div>
    </footer>
  );
}
