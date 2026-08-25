import { useEffect, useState } from "react";
import type { CanvasController, CanvasState } from "../canvas.js";

// 離開播放/全螢幕 stay text buttons, matching the pre-existing (pre-#48)
// play chrome verbatim — see the class comment below. base-shell.html's
// icon-only 全螢幕/離開播放 buttons are not adopted for these two: the
// 裁決 2 freeze (既有 e2e 的文字選擇器，見下方註解) still applies to them.
// 上一步/下一步 are new elements no existing test depends on the shape
// of, so *those two* do follow the template's own SVG verbatim (fleet
// commander's 裁決 A, 2026-08-25) — see the buttons below.

/** 游標與控制列一起隱去前的閒置時間 (#54 AC3)。 */
const IDLE_MS = 2500;

export interface PlayChromeProps {
  state: CanvasState;
  controller: CanvasController | null;
  isFullscreen: boolean;
  /** 全螢幕失敗訊息；與播放錯誤同列堆疊，不互相覆蓋。 */
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
 * play-only error notice or 離開播放, which have no meaning outside
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
    // component's concern here — 離開播放 and state.error (播放中的效果
    // 清單錯誤) only mean something in 播放模式 and must not render
    // outside it.
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
      {/* gate round 1 (2026-08-25), high finding: 投影片 iframe 佔了播放
          畫面約 87% 面積（指揮官量測，1440×900 下 iframe box 1415×796），
          滑鼠在 iframe 內移動時瀏覽器把 mousemove 直接派送給 iframe 自己
          的文件，不會冒泡到上層——這是跨 document/frame 邊界事件的既有
          限制，不是這裡新引入的 bug，但原本的 e2e 測試繞開了它而不是
          回報它，這正是被抓到的問題（見 play-appearance.test.ts 的對照
          表）。這一層透明覆蓋層鋪在 `.canvas`（iframe 所在，z-index
          auto）之上、`.player-notices`/`.play-bar`（皆 z-index:2，見
          style.css/shell.css）之下（見 play.css 的 z-index:1），讓
          mousemove 落在上層文件本身，冒泡到上面 `awake` 那個 effect 已有
          的 `document` 監聽器——不需要另外接 onMouseMove，冒泡本來就會到。

          攔下 pointer 事件的代價是原生的「點 iframe 給它瀏覽器焦點」不再
          發生：`player-runtime.js` 全 spec 凍結，已核對它只有
          keydown/resize/focus/blur/message 五個監聽器，不處理 click，
          效果清單解析失敗的靜態降級頁更是完全沒有 runtime，所以這裡沒有
          任何既有的 click 行為要保；用既有的 `controller.focusPlayer()`
          （全螢幕切換等處已在用的同一支函式）補回鍵盤焦點即可。 */}
      <div className="play-mousemove-catcher" onClick={() => controller?.focusPlayer()} />
      {/* 播放模式的浮動通知：播放錯誤與全螢幕錯誤可能同時成立（效果清單
          解析失敗又剛好全螢幕請求也失敗），過去各自用同一組絕對定位互相
          疊在一起，後渲染的會蓋住先渲染的（review gate round 1, P2）。這個
          wrapper 把它們收進同一個 flex column，各自的樣式只留背景／文字，
          定位與間距交給 wrapper，讓它們並排堆疊而不互相覆蓋。

          焦點提示曾經是這裡的第三則（#54）。#68 撤掉了它：它要求正在播報
          的人先用滑鼠去點一顆按鈕，才能繼續按方向鍵——而走得到它的路徑
          （按一次 Tab，實測確認）本身就是純鍵盤操作。現在失焦時方向鍵照樣
          推進（見 App.tsx 的 keydown 轉發），提示因此無事可報。 */}
      {(state.error || fullscreenError) && (
        <div className="player-notices">
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
      {/* #68: 播放器是否真的握著鍵盤焦點，過去只能從焦點提示在不在 DOM 裡
          反推。提示撤掉後這個狀態仍然要看得見——e2e 用它當「焦點已經交出去
          了」的同步點，否則測試只能睡固定秒數去賭。這是狀態的實話，不是給
          使用者看的介面，所以是 data 屬性而非任何可見元素。 */}
      <nav className={awake ? "play-bar awake" : "play-bar"} data-player-focus={state.playerHasFocus}>
        {/* 上一步／下一步是換頁，不是換效果步驟 (裁決 3): 效果清單解析失敗
            時沒有任何 runtime 活著回應方向鍵，這兩顆鈕是 #54 要求的換頁
            替代途徑，接的是 controller.previous()/next()（＝
            showSlide(currentIndex±1)），不是 player-runtime.js 的步驟推進。
            兩顆鈕的 SVG 逐字照抄 base-shell.html:420-421 的 path（fleet
            指揮官 裁決 A，2026-08-25）：這兩個是本票新增的元素，沒有任何
            既有測試依賴它們的形狀，裁決 2 的文字選擇器凍結只涵蓋既有的
            離開播放/全螢幕，不涵蓋這兩顆——不再沿用 StatusBar 的
            `.slide-nav-button`（那組樣式是給文字 ‹/› 用的，圖示鈕改用
            `.play-bar` 自己的 button 樣式，見 play.css）。 */}
        <button
          type="button"
          className="play-nav-button"
          aria-label="上一步"
          disabled={state.currentIndex <= 0}
          onClick={() => void controller?.previous()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M10 3 L5 8 L10 13" />
          </svg>
        </button>
        <button
          type="button"
          className="play-nav-button"
          aria-label="下一步"
          disabled={state.currentIndex < 0 || state.currentIndex >= state.slides.length - 1}
          onClick={() => void controller?.next()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M6 3 L11 8 L6 13" />
          </svg>
        </button>
        {/* 頁碼：樣板的 `N / M` 形式（base-shell.html:422 的 `.pos`），不是
            狀態列的「第 N 頁，共 M 頁」——那句是 #53 給狀態列的規定，播放
            時狀態列已不在 DOM 裡，兩者不衝突（fleet 指揮官 裁決 A）。 */}
        <span className="play-bar-position">
          {state.currentIndex >= 0 ? `${state.currentIndex + 1} / ${state.slides.length}` : "– / –"}
        </span>
        <span className="play-bar-divider" />
        {/* gate round 2 (2026-08-25), medium finding: 樣板
            (base-shell.html:419-426，波指揮官在 1440×900 用 Playwright
            量過的順序) 是「全螢幕、離開播放」，這裡原本反了。裁決 2 凍結
            的是這兩顆的 class 與文字（既有 e2e 用 button:has-text() 這類
            文字選擇器抓它們），不含順序，所以純粹搬動 JSX 區塊、class 與
            文字一個字不動，不牴觸 裁決 2。
            全螢幕開關 (ticket #29): 是否全螢幕由作者決定，工具不預設強制
            (settled decision #6). */}
        <button type="button" className="fullscreen-toggle-button" onClick={() => void onToggleFullscreen()}>
          {isFullscreen ? "退出全螢幕" : "全螢幕"}
        </button>
        <button type="button" className="play-toggle-button leave" onClick={() => void onExitPlay()}>
          離開播放
        </button>
      </nav>
    </>
  );
}
