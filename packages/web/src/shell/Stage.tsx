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
import type { CanvasController, CanvasState } from "../canvas.js";
import { Dock } from "./dock/Dock.js";
import { OverlayLayer } from "./stage-overlays/OverlayLayer.js";
import type { SideId } from "./side/SidePanel.js";
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
  /**
   * NOOP-83 §2.1/§4：投影片本體上的滾輪縮放/平移、抓取模式拖曳、Space 暫時
   * 抓取都經由 canvas.ts 的 `subscribeStageInput`/`setStageHandMode`/
   * `clearSelection` 轉發（selection-runtime.js 是實際來源）。`null`（首次
   * render，比照既有 `PlayChrome` 的 `controllerRef.current` 用法）時舞台
   * 導航僅在留白區生效，不報錯、等下一次 render 拿到非 null 的值。
   */
  controller: CanvasController | null;
  /** [E2.T7]：情境列的 Edit animation 按鈕——只切右欄到 Animate › Object，狀態owner 是 App.tsx（D10）。 */
  onEditAnimation(): void;
  /** [E2.T7]/D9：右欄目前停在哪個主分頁——只用來決定舞台動畫徽章要不要顯示（見 OverlayLayer 的 showBadges）。 */
  side: SideId;
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
export function Stage({ canvasRef, wellRef, canvasSize, state, dropOverlay, controller, onEditAnimation, side, children }: StageProps) {
  const [zoomPan, setZoomPan] = useState<ZoomPanState>(initialZoomPan);
  const [hand, setHand] = useState<HandState>(initialHandState);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPan: ZoomPanState["pan"] } | null>(null);
  // 播放模式時舞台導航整個停用（比照 comotion-logic-v3.js 的 wellWheel/
  // wellDown 兩者都對 `mode === "play"` 提前 return），Dock／疊層也跟著
  // shellVisible 一起從 DOM 消失，比照 App.tsx 對 Titlebar/Rail/側欄的既有
  // 作法（播放模式時整組不掛載，不是 CSS 隱藏）。
  const shellVisible = state.mode !== "play";

  // 給 stage-input relay 用的「最新值」讀取口——effect 只在 controller 變
  // 動時重新訂閱一次（見下方），訂閱期間收到的每個事件都要讀到當下的
  // zoomPan，不是訂閱那一刻的舊值，所以用 ref 而非直接關閉 zoomPan 這個
  // state 變數。
  const zoomPanRef = useRef(zoomPan);
  zoomPanRef.current = zoomPan;

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

  // 抓取模式（✋ 或 Space 暫時抓取）狀態變動時同步推給 canvas.ts——它是唯一
  // 知道要不要把這個狀態重推給 selection-runtime.js（切頁後、
  // "runtime-ready"）的一方，這裡只管把最新值交給它（NOOP-83 §2.1(c)）。
  useEffect(() => {
    controller?.setStageHandMode(isHandActive(hand));
  }, [controller, hand]);

  // 縮放/平移後疊層（名稱標籤、情境列、右鍵選單）要跟著投影片走：runtime 回
  // 報的座標是 iframe 自己的 client px，不受 `.stage` 的 transform 影響，只
  // 有父文件這邊的換算會過期，所以 zoomPan 一變就請 controller 用新的 frame
  // 位置重算一次（useEffect 在 transform 已 commit 之後跑）。
  useEffect(() => {
    if (!shellVisible) return;
    controller?.refreshOverlay();
  }, [controller, shellVisible, zoomPan]);

  // 投影片本體上的滾輪縮放/平移、抓取模式拖曳（NOOP-83 §2/§4，Dev-Leader
  // 裁決核准的擴大範圍）：canvas.ts 已經把 selection-runtime.js 回報的
  // iframe 內座標換算成這個文件的 client 座標，所以下面的數學跟
  // handleWheel／handleMouseDown 對留白區做的完全一樣，不重寫一份。
  useEffect(() => {
    if (!controller || !shellVisible) return;
    return controller.subscribeStageInput((event) => {
      switch (event.type) {
        case "wheel-zoom": {
          const rect = wellRef.current?.getBoundingClientRect();
          const anchor = rect
            ? { x: event.point.x - rect.left - rect.width / 2, y: event.point.y - rect.top - rect.height / 2 }
            : { x: 0, y: 0 };
          setZoomPan((current) => zoomByWheel(current, event.deltaY, anchor));
          return;
        }
        case "wheel-pan":
          setZoomPan((current) => panBy(current, -event.deltaX, -event.deltaY));
          return;
        case "pan-start":
          dragRef.current = { startX: event.point.x, startY: event.point.y, startPan: zoomPanRef.current.pan };
          setDragging(true);
          return;
        case "pan-move": {
          const drag = dragRef.current;
          if (!drag) return;
          setZoomPan((current) => ({
            zoom: current.zoom,
            pan: { x: drag.startPan.x + (event.point.x - drag.startX), y: drag.startPan.y + (event.point.y - drag.startY) },
          }));
          return;
        }
        case "pan-end":
          dragRef.current = null;
          setDragging(false);
          return;
        case "space-down":
          setHand((current) => pressSpace(current));
          return;
        case "space-up":
          setHand((current) => releaseSpace(current));
          return;
      }
    });
  }, [controller, shellVisible, wellRef]);

  /**
   * 留白區（`.canvas-area` 的 padding 背景）自己的滾輪/拖曳處理——投影片
   * 本體上的同一批操作走上面 `subscribeStageInput` 的 relay，見該 effect
   * 的註解。兩條路徑共用這裡的縮放/平移數學，沒有重複一份。
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
      // 05-INTERACTIONS.feature「抓取模式」：開啟時清除目前選取
      // (NOOP-83 §2.1(b)/§4.5)。
      controller?.clearSelection();
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
    <div
      className="canvas-area"
      ref={wellRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      style={{ cursor: wellCursor }}
      // Grab mode (✋ or Space held): the context bar stops intercepting the
      // pointer (stage-overlays.css) so a drag that starts over it still
      // reaches the slide and pans — `isOnStageChrome` would otherwise swallow
      // that mousedown as "UI chrome".
      data-grab={isHandActive(hand) ? "true" : undefined}
    >
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
      {shellVisible && (
        <OverlayLayer
          controller={controller}
          wellRef={wellRef}
          onEditAnimation={onEditAnimation}
          showBadges={side === "animate" && state.mode === "view"}
        />
      )}
      {shellVisible && (
        <Dock
          zoomPan={zoomPan}
          onZoomPanChange={setZoomPan}
          hand={hand}
          onToggleHand={handleToggleHand}
          selection={state.selection}
          controller={controller}
          slidePath={state.currentIndex >= 0 ? state.slides[state.currentIndex] : null}
          onAnimationAdded={onEditAnimation}
          canvasSize={canvasSize}
        />
      )}
      {children}
    </div>
  );
}
