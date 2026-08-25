import type { CanvasController, CanvasState } from "../canvas.js";

// No icons in this file: 離開播放/全螢幕 stay text buttons, matching the
// pre-existing (pre-#48) play chrome verbatim — see the class comment
// below. base-shell.html's icon-only play-bar buttons are not adopted
// here to avoid rewriting tested behaviour that isn't broken.

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
      <nav className="play-bar">
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
