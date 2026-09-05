import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { CanvasController, OverlayState } from "../../canvas.js";
import { SelectionOverlay } from "./SelectionOverlay.js";
import { ContextBar } from "./ContextBar.js";
import { CommentLayer } from "./CommentLayer.js";
import { GuideLayer } from "./GuideLayer.js";
import { ContextMenu } from "./ContextMenu.js";

export interface OverlayLayerProps {
  controller: CanvasController | null;
  /** `.canvas-area`'s own ref (Stage.tsx) — `.stage-overlays` is positioned relative to it, so every value `controller.subscribeOverlay` reports (parent-document client px) needs this element's own `getBoundingClientRect()` subtracted before it means anything as a `left`/`top` CSS value here. */
  wellRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}

const EMPTY_OVERLAY: OverlayState = { boxes: [], union: null, label: null, guides: [], contextMenu: null };

/**
 * 舞台疊層的根容器：`pointer-events: none`（個別可互動元件——情境列按鈕、
 * 右鍵選單——自己開回 `pointer-events: auto`，見 stage-overlays.css），坐在
 * `.canvas` 上方，且**不**隨 `.stage` 的縮放/平移 transform 一起變形
 * （`getBoundingClientRect()` 換算全部由這裡的 `toLocal*` 做，讀 `wellRef`
 * 當下的框）。
 *
 * NOOP-90/T2：四個子層從 T1 的空容器開始接上真正的內容——選取/群組/鑽入
 * 標籤（SelectionOverlay）、吸附輔助線（GuideLayer）、只有 Delete 一顆按
 * 鈕的情境列（ContextBar，見該檔案的範圍裁決）、元素右鍵選單（ContextMenu，
 * 新檔）。CommentLayer 維持空容器（留言 pin 是 NOOP-67 的範圍）。
 *
 * 已知限制：這裡的座標只在 `controller.subscribeOverlay` 真的推送新狀態
 * （選取變化、拖曳中的每一幀）時重新讀 `wellRef` 的框——單純縮放/平移舞台
 * （Stage.tsx 自己的 zoomPan state）不會觸發 overlay 更新，所以標籤/情境
 * 列/輔助線在「選取後只縮放不動選取」的當下會暫時跟不上，直到下一次選取
 * 變化。修好它要讓 Stage.tsx 的 zoomPan 變化也推一次 overlay 刷新，這張票
 * 沒有做（見 PR 報告「不確定與保留事項」）。
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

  function toLocalPoint(point: { x: number; y: number }): { x: number; y: number } {
    return { x: point.x - offsetX, y: point.y - offsetY };
  }
  function toLocalRect(rect: { x: number; y: number; width: number; height: number }) {
    return { x: rect.x - offsetX, y: rect.y - offsetY, width: rect.width, height: rect.height };
  }

  const union = overlay.union ? toLocalRect(overlay.union) : null;
  const guides = overlay.guides.map((guide) => ({
    orientation: guide.orientation,
    position: guide.orientation === "v" ? guide.position - offsetX : guide.position - offsetY,
  }));

  return (
    <div className="stage-overlays">
      <SelectionOverlay union={union} label={overlay.label} />
      <ContextBar union={union} bounds={bounds} onDelete={() => void controller?.deleteSelection()} />
      <CommentLayer />
      <GuideLayer guides={guides} />
      {overlay.contextMenu && controller && (
        <ContextMenu
          point={toLocalPoint(overlay.contextMenu.point)}
          bounds={bounds}
          onClose={() => controller.closeContextMenu()}
          onDelete={() => void controller.deleteSelection()}
          onDuplicate={() => void controller.duplicateSelection()}
          onOrder={(direction) => void controller.orderSelection(direction)}
        />
      )}
      {children}
    </div>
  );
}
