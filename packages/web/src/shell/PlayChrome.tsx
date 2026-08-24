import { useEffect, useState } from "react";
import type { CanvasController, CanvasState } from "../canvas.js";

// No icons in this file: 離開播放/全螢幕 stay text buttons, matching the
// pre-existing (pre-#48) play chrome verbatim — see the class comment
// below. base-shell.html's icon-only play-bar buttons are not adopted
// here to avoid rewriting tested behaviour that isn't broken.

/** 游標與控制列一起隱去前的閒置時間 (#54 AC3)。 */
const IDLE_MS = 2500;

export interface PlayChromeProps {
  state: CanvasState;
  controller: CanvasController | null;
  isFullscreen: boolean;
  /** 全螢幕失敗訊息；與焦點提示、播放錯誤同列堆疊，不互相覆蓋。 */
  fullscreenError: string | null;
  onToggleFullscreen(): void;
  onExitPlay(): void;
}

/**
 * Play-mode chrome: the floating notices and the 離開播放/全螢幕 controls.
 * Renders nothing outside 播放模式. Classes and copy are moved verbatim
 * from App.tsx's pre-existing play nav — see the round 1/2/3/4 review-gate
 * comments below, each fixing a real bug this markup used to have.
 *
 * gate round 2, medium finding: 全螢幕 is available from the ribbon in
 * 檢視模式 too (#0.2 item 2's ruling — orthogonal to play mode), but this
 * component used to return null outright whenever `state.mode !== "play"`.
 * That left a successful 檢視模式 fullscreen request with no in-app way
 * back out (only the browser's own Esc), and a *rejected* request with no
 * visible error at all — a silent failure, which this project's own
 * posture ("寧可拋錯也不要靜默") forbids. The two blocks below split
 * cleanly on `isPlayMode`: the 播放模式 block is untouched, byte-for-byte,
 * from before this fix; the 檢視模式 block is new and only ever renders
 * the fullscreen exit control and/or its own error notice — never the
 * play-only focus/error notices or 離開播放, which have no meaning outside
 * 播放模式.
 */
export function PlayChrome({ state, controller, isFullscreen, fullscreenError, onToggleFullscreen, onExitPlay }: PlayChromeProps) {
  const isPlayMode = state.mode === "play";

  // 游標與控制列一起隱去 (#54 AC3/AC4)：`awake` toggles both — this
  // component's own `.play-bar.awake` class (opacity, styles/play.css) and,
  // via play.css's `:has(.play-bar.awake)` selector on `.app[data-mode=
  // "play"]`, the ancestor cursor. App.tsx is frozen beyond two narrow
  // grants that do not include adding a class up there, so the toggle has
  // to reach upward through `:has()` instead of downward from a parent
  // state — see the wave brief's "suggested containment" section.
  // Declared unconditionally (not after the `!isPlayMode` early return
  // below) because hooks cannot be conditional; its own effect body no-ops
  // outside play mode instead.
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    if (!isPlayMode) return;
    setAwake(true);
    let timer = window.setTimeout(() => setAwake(false), IDLE_MS);
    function onMouseMove(): void {
      setAwake(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAwake(false), IDLE_MS);
    }
    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      window.clearTimeout(timer);
    };
  }, [isPlayMode]);

  if (!isPlayMode) {
    // 檢視模式: only fullscreen (state and/or its error) is this
    // component's concern here — 離開播放, playerHasFocus, and
    // state.error (播放中的效果清單錯誤) all only mean something in
    // 播放模式 and must not render outside it.
    if (!isFullscreen && !fullscreenError) return null;
    return (
      <>
        {fullscreenError && (
          <div className="player-notices">
            <div className="player-error-notice" role="alert">
              全螢幕切換失敗：{fullscreenError}
            </div>
          </div>
        )}
        {isFullscreen && (
          <nav className="view-fullscreen-bar">
            <button
              type="button"
              className="fullscreen-toggle-button"
              aria-label="退出全螢幕"
              onClick={() => void onToggleFullscreen()}
            >
              退出全螢幕
            </button>
          </nav>
        )}
      </>
    );
  }

  return (
    <>
      {/* 播放模式的浮動通知：焦點提示、播放錯誤、全螢幕錯誤都可能同時成立
          （例如效果清單解析失敗又剛好全螢幕請求也失敗），過去三者各自用
          同一組絕對定位互相疊在一起，後渲染的會蓋住先渲染的（review gate
          round 1, P2）。這個 wrapper 把它們收進同一個 flex column，各自的
          樣式只留背景／文字，定位與間距交給 wrapper，讓它們並排堆疊而不
          互相覆蓋. */}
      {(!state.playerHasFocus || state.error || fullscreenError) && (
        <div className="player-notices">
          {!state.playerHasFocus && (
            <div className="player-focus-notice" role="alert">
              <p>焦點不在播放器上，方向鍵目前不會有反應。</p>
              <button type="button" onClick={() => controller?.focusPlayer()}>
                點這裡把焦點交回播放器
              </button>
            </div>
          )}
          {state.error && (
            <div className="player-error-notice" role="alert">
              這一頁的效果清單無法播放：{state.error}
            </div>
          )}
          {fullscreenError && (
            <div className="player-error-notice" role="alert">
              全螢幕切換失敗：{fullscreenError}
            </div>
          )}
        </div>
      )}
      <nav className={awake ? "play-bar awake" : "play-bar"}>
        {/* 上一步／下一步是換頁，不是換效果步驟 (裁決 3): 效果清單解析失敗
            時沒有任何 runtime 活著回應方向鍵，這兩顆鈕是 #54 要求的換頁
            替代途徑，接的是 controller.previous()/next()（＝
            showSlide(currentIndex±1)），不是 player-runtime.js 的步驟推進。
            class 沿用 StatusBar 既有的 `.slide-nav-button`/`.slide-nav-
            position` 契約 (#25/#29)，同一份樣式在播放列的深色背景上量測
            起來與樣板的 pos/按鈕視覺一致，不需要另開一組新 class。 */}
        <button
          type="button"
          className="slide-nav-button"
          aria-label="上一步"
          disabled={state.currentIndex <= 0}
          onClick={() => void controller?.previous()}
        >
          ‹
        </button>
        <button
          type="button"
          className="slide-nav-button"
          aria-label="下一步"
          disabled={state.currentIndex < 0 || state.currentIndex >= state.slides.length - 1}
          onClick={() => void controller?.next()}
        >
          ›
        </button>
        <span className="slide-nav-position">
          {state.currentIndex >= 0 ? `第 ${state.currentIndex + 1} 頁，共 ${state.slides.length} 頁` : "尚無投影片"}
        </span>
        <span className="play-bar-divider" />
        <button type="button" className="play-toggle-button leave" onClick={() => void onExitPlay()}>
          離開播放
        </button>
        {/* 全螢幕開關 (ticket #29): 是否全螢幕由作者決定，工具不預設強制
            (settled decision #6). */}
        <button type="button" className="fullscreen-toggle-button" onClick={() => void onToggleFullscreen()}>
          {isFullscreen ? "退出全螢幕" : "全螢幕"}
        </button>
      </nav>
    </>
  );
}
