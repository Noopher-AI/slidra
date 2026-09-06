import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { CanvasController, OverlayState } from "../../canvas.js";
import { SelectionOverlay } from "./SelectionOverlay.js";
import { ContextBar } from "./ContextBar.js";
import { CommentLayer } from "./CommentLayer.js";
import { GuideLayer } from "./GuideLayer.js";

export interface OverlayLayerProps {
  controller: CanvasController | null;
  /** `.canvas-area`'s own ref (Stage.tsx) — `.stage-overlays` is positioned relative to it, so every value `controller.subscribeOverlay` reports (parent-document client px) needs this element's own `getBoundingClientRect()` subtracted before it means anything as a `left`/`top` CSS value here. */
  wellRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}

const EMPTY_OVERLAY: OverlayState = { boxes: [], union: null, label: null, guides: [], dragging: false };

/** `controller.subscribeOverlay`'s parent-document client px -> `.stage-overlays`-relative px, given the well's own `getBoundingClientRect()` offset. Exported so the coordinate math itself is directly unit-testable without mounting the whole layer (NOOP-91 round-2 FAIL #4). */
export function toLocalPoint(
  point: { x: number; y: number },
  offset: { x: number; y: number },
): { x: number; y: number } {
  return { x: point.x - offset.x, y: point.y - offset.y };
}

/** Same conversion as `toLocalPoint`, applied to a rect — width/height are already well-relative sizes, so only the corner shifts. */
export function toLocalRect(
  rect: { x: number; y: number; width: number; height: number },
  offset: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  return { x: rect.x - offset.x, y: rect.y - offset.y, width: rect.width, height: rect.height };
}

/**
 * 舞台疊層的根容器：`pointer-events: none`（個別可互動元件——情境列按鈕、
 * 右鍵選單——自己開回 `pointer-events: auto`，見 stage-overlays.css），坐在
 * `.canvas` 上方，且**不**隨 `.stage` 的縮放/平移 transform 一起變形
 * （`getBoundingClientRect()` 換算全部由這裡的 `toLocal*` 做，讀 `wellRef`
 * 當下的框）。
 *
 * NOOP-90/T2：子層從 T1 的空容器開始接上真正的內容——選取/群組/鑽入標籤
 * （SelectionOverlay）、吸附輔助線（GuideLayer）、情境列（ContextBar：Order／
 * Duplicate／Delete 已接功能，其餘為佈局佔位；原本的元素右鍵選單在 issue 198
 * review 時移除，項目併入這一列）。CommentLayer 維持空容器（留言 pin 是
 * NOOP-67 的範圍）。
 *
 * 座標只在 `controller.subscribeOverlay` 推送新狀態時重新讀 `wellRef` 的框。
 * 單純縮放/平移舞台（Stage.tsx 的 zoomPan state）不會讓 runtime 重發
 * bounds，所以 Stage.tsx 在 zoomPan 變化後呼叫 `controller.refreshOverlay()`
 * 讓 canvas.ts 用新的 frame 位置重算並再推一次——標籤/情境列/右鍵選單因此
 * 跟著投影片走，不用等下一次選取變化。
 */
export function OverlayLayer({ controller, wellRef, children }: OverlayLayerProps) {
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);

  useEffect(() => {
    if (!controller) {
      setOverlay(EMPTY_OVERLAY);
      return;
    }
    return controller.subscribeOverlay(setOverlay);
  }, [controller]);

  const wellRect = wellRef.current?.getBoundingClientRect();
  const offsetX = wellRect?.left ?? 0;
  const offsetY = wellRect?.top ?? 0;
  const bounds = { width: wellRect?.width ?? 0, height: wellRect?.height ?? 0 };
  const offset = { x: offsetX, y: offsetY };

  const union = overlay.union ? toLocalRect(overlay.union, offset) : null;
  const guides = overlay.guides.map((guide) => ({
    orientation: guide.orientation,
    position: guide.orientation === "v" ? guide.position - offsetX : guide.position - offsetY,
  }));

  return (
    <div className="stage-overlays">
      <SelectionOverlay union={union} label={overlay.label} />
      <ContextBar
        union={union}
        bounds={bounds}
        dragging={overlay.dragging}
        onOrder={(direction) => void controller?.orderSelection(direction)}
        onDuplicate={() => void controller?.duplicateSelection()}
        onDelete={() => void controller?.deleteSelection()}
      />
      <CommentLayer />
      <GuideLayer guides={guides} />
      {children}
    </div>
  );
}
