import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { CanvasState } from "../canvas.js";
import { Dock } from "./dock/Dock.js";
import { OverlayLayer } from "./stage-overlays/OverlayLayer.js";
import {
  initialHandState,
  initialZoomPan,
  isHandActive,
  panBy,
  pressSpace,
  releaseSpace,
  toggleHand,
  zoomByWheel,
  type HandState,
  type ZoomPanState,
} from "./stage-view.js";

export interface StageProps {
  /** canvas.ts 掛載 iframe 的容器。這個 DOM 節點的身分與位置永遠不能變。 */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** 舞台底＝全螢幕目標＝播放黑幕容器＝縮放/平移的滾輪與拖曳事件來源。 */
  wellRef: RefObject<HTMLDivElement | null>;
  /** 舞台比例來源；null 時吃 CSS 的 16/9 fallback。 */
  canvasSize: { width: number; height: number } | null;
  state: CanvasState;
  /** T3/NOOP-142 既有的拖放匯入媒體 overlay（與這張骨架票無關，維持原樣）。 */
  dropOverlay: { active: boolean; onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void; onDragLeave: (event: DragEvent) => void };
  /** 播放通知與 PlayChrome。必須渲染在全螢幕目標之內，否則全螢幕時點不到。 */
  children?: ReactNode;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/** Dock／舞台疊層自己的按鈕與浮層——落在這些容器裡的 mousedown 不該被當成「點空白」而觸發平移。 */
function isOnStageChrome(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest(".dock, .stage-overlays");
}

/**
 * 舞台 (New v3 skeleton)：深色 well → 縮放/平移 transform frame → 既有的
 * `.canvas` div（身分不變）→ 疊層堆疊（空容器，見 stage-overlays/）。縮放/
 * 平移/抓取模式狀態全部委派給 stage-view.ts 的純函式（見該檔案與
 * packages/web/test/stage-view.test.ts）——這個元件只負責接 DOM 事件、換算
 * 一次座標、呼叫那些函式。
 *
 * `canvasRef` 的 div 在這裡的 JSX 位置與條件完全沒變（還是 `.stage` 底下唯
 * 一、無條件渲染的子節點，沒有新的 `key`）——canvas.ts 的 `mountCanvas`
 * 只跑一次並永遠抓著這個節點，弄丟身分等於讓掛進去的 iframe 靜默變成孤兒
 * （白畫面、不報錯）。`.stage` 本身現在多了一個 inline `transform`
 * （平移+縮放），這對 canvas.ts 完全透明——它的座標數學全部發生在 iframe
 * 自己的文件座標系裡，祖先層的 CSS transform 不影響那個座標系。
 */
export function Stage({ canvasRef, wellRef, canvasSize, state, dropOverlay, children }: StageProps) {
  const [zoomPan, setZoomPan] = useState<ZoomPanState>(initialZoomPan);
  const [hand, setHand] = useState<HandState>(initialHandState);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPan: ZoomPanState["pan"] } | null>(null);
  // 播放模式時舞台導航整個停用（比照 comotion-logic-v3.js 的 wellWheel/
  // wellDown 兩者都對 `mode === "play"` 提前 return），Dock／疊層也跟著
  // shellVisible 一起從 DOM 消失，比照 App.tsx 對 Titlebar/Rail/側欄的既有
  // 作法（播放模式時整組不掛載，不是 CSS 隱藏）。
  const shellVisible = state.mode !== "play";

  // Space 暫時抓取 (05-INTERACTIONS.feature「暫時抓取」)：按住等同抓取模
  // 式，放開恢復原本的 hand 狀態；視窗失焦視同放開（不會卡在抓取模式）；
  // 焦點在輸入框時不啟用（比照 App.tsx 既有 ⌘Z 的 focus guard）。
  useEffect(() => {
    if (!shellVisible) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== " " && event.code !== "Space") return;
      if (isTextInputTarget(event.target)) return;
      event.preventDefault();
      setHand((current) => pressSpace(current));
    }
    function onKeyUp(event: KeyboardEvent): void {
      if (event.key !== " " && event.code !== "Space") return;
      setHand((current) => releaseSpace(current));
    }
    function onWindowBlur(): void {
      setHand((current) => releaseSpace(current));
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [shellVisible]);

  /**
   * 已知缺口（本票驗證時發現，計畫沒預期到，寫在這裡讓下一個動這段程式碼
   * 的人不必重新踩一次）：`.canvas` 是一個 sandboxed iframe，滑鼠事件一旦
   * 落在它渲染的矩形範圍內就完全由 iframe 自己的文件收下，不會冒泡到這個
   * React `onWheel` handler——已用 Playwright 實測驗證：wheel 落在
   * `.canvas-area` 的留白（padding）背景上會被這裡收到，落在 `.stage`／
   * iframe 範圍內則完全收不到事件（見 NOOP-81 Execute 交付留言的驗證紀
   * 錄）。也就是說滾輪縮放/平移目前只在使用者滑鼠剛好停在投影片周圍留白
   * 才生效，停在投影片本體上（畫面絕大部分面積）不會有反應。修法是比照
   * `canvas.ts` 既有的 `dragSignal` postMessage relay（selection-runtime.js
   * 在 iframe 內監聽再轉發），幫 wheel 事件也做一份——但這需要擴充
   * `CanvasState` 的形狀並改 selection-runtime.js，兩者都在這張骨架票明
   * 確畫定的「canvas.ts/selection-runtime.js 不得修改」範圍之外，所以本票
   * 不動它，只補這個註解與 PR 報告裡的風險項目。
   */
  function handleWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!shellVisible || isOnStageChrome(event.target)) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // 錨點是相對 well 中心的偏移量（比照 comotion-logic-v3.js 的
      // wellWheel），因為 `.stage` 的置中／平移／縮放全部疊在同一個原點上。
      const rect = wellRef.current?.getBoundingClientRect();
      const anchor = rect
        ? { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
        : { x: 0, y: 0 };
      setZoomPan((current) => zoomByWheel(current, event.deltaY, anchor));
    } else {
      setZoomPan((current) => panBy(current, -event.deltaX, -event.deltaY));
    }
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!shellVisible || isOnStageChrome(event.target)) return;
    const target = event.target as HTMLElement;
    const onStage = !!target.closest(".stage");
    const shouldPan = event.button === 1 || isHandActive(hand) || !onStage;
    if (!shouldPan) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startPan = zoomPan.pan;
    dragRef.current = { startX, startY, startPan };
    setDragging(true);
    function onMove(moveEvent: globalThis.MouseEvent): void {
      const drag = dragRef.current;
      if (!drag) return;
      setZoomPan((current) => ({
        zoom: current.zoom,
        pan: { x: drag.startPan.x + (moveEvent.clientX - drag.startX), y: drag.startPan.y + (moveEvent.clientY - drag.startY) },
      }));
    }
    function onUp(): void {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleToggleHand(): void {
    const { state: next, selectionCleared } = toggleHand(hand);
    setHand(next);
    if (selectionCleared) {
      // 05-INTERACTIONS.feature「抓取模式」：開啟時清除目前選取。
      // canvas.ts 沒有提供獨立的「清除選取」API——選取/拖曳/縮放整組是這張
      // 骨架票明確排除的範圍（見 ticket 說明），這裡先把訊號接住、留一個
      // 目前沒有動作的分支，等未來票把選取狀態搬進來時在這裡補上真正的呼
      // 叫。見 PR 報告「不確定與保留事項」。
    }
  }

  const aspectStyle: CSSProperties = canvasSize
    ? { aspectRatio: `${canvasSize.width} / ${canvasSize.height}` }
    : { visibility: "hidden" };
  // 播放模式（!shellVisible）永遠以 identity transform 呈現，忽略當下存的
  // zoomPan——#29 既有的全螢幕回歸契約（e2e/player-fullscreen.test.ts 斷言
  // frameSize[0] === screenSize[0]）優先於編輯模式的縮放/平移狀態；zoomPan
  // 本身不清空，回到檢視模式時原本的縮放/平移原封不動恢復。
  // `translate(-50%, -50%)` is the self-centering half of stage.css's
  // `top/left: 50%` trick (undoing the offset against `.stage`'s own size)
  // — always present, even during play, or `.stage` would jump to the
  // grid track's top-left corner instead of staying centred. The pan/zoom
  // portion composes after it, and is dropped entirely (not just left at
  // identity) while `!shellVisible`, per the comment above.
  const centering = "translate(-50%, -50%)";
  const stageStyle: CSSProperties = {
    ...aspectStyle,
    transform: shellVisible ? `${centering} translate(${zoomPan.pan.x}px, ${zoomPan.pan.y}px) scale(${zoomPan.zoom})` : centering,
  };
  const wellCursor = dragging ? "grabbing" : isHandActive(hand) ? "grab" : undefined;

  return (
    <div className="canvas-area" ref={wellRef} onWheel={handleWheel} onMouseDown={handleMouseDown} style={{ cursor: wellCursor }}>
      <div className="stage" style={stageStyle}>
        <div ref={canvasRef} className="canvas" />
        {/* T3/NOOP-142: pointer-events stays "none" until App.tsx sets
            `active` true — otherwise this div would sit over the iframe at
            all times and swallow every click/drag NOOP-91's direct
            manipulation depends on. */}
        <div
          className="drop-overlay"
          data-active={dropOverlay.active}
          style={{ pointerEvents: dropOverlay.active ? "auto" : "none" }}
          onDragOver={(event) => {
            event.preventDefault();
            dropOverlay.onDragOver(event);
          }}
          onDrop={dropOverlay.onDrop}
          onDragLeave={dropOverlay.onDragLeave}
        />
      </div>
      {shellVisible && <OverlayLayer />}
      {shellVisible && (
        <Dock
          zoomPan={zoomPan}
          onZoomPanChange={setZoomPan}
          hand={hand}
          onToggleHand={handleToggleHand}
          selection={state.selection}
        />
      )}
      {children}
    </div>
  );
}
