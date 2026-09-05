import type { ReactNode } from "react";
import { SelectionOverlay } from "./SelectionOverlay.js";
import { ContextBar } from "./ContextBar.js";
import { CommentLayer } from "./CommentLayer.js";
import { GuideLayer } from "./GuideLayer.js";

export interface OverlayLayerProps {
  children?: ReactNode;
}

/**
 * 舞台疊層的根容器：`pointer-events: none`，坐在 `.canvas` 上方，且**不**
 * 隨 `.stage` 的縮放/平移 transform 一起變形（那會讓 `getBoundingClientRect()`
 * 自動幫忙換算座標，但目前這一層完全沒有內容，換算邏輯只在 stage-view.ts
 * 的 `clientPointToContentPoint` 準備好，等未來票真的畫東西時再用——見
 * Stage.tsx 對這個決定的說明）。四個子層現在都是空容器：真正畫選取框／情
 * 境列／留言／輔助線是選取與拖曳票的範圍，這張骨架票不做。
 */
export function OverlayLayer({ children }: OverlayLayerProps) {
  return (
    <div className="stage-overlays" aria-hidden="true">
      <SelectionOverlay />
      <ContextBar />
      <CommentLayer />
      <GuideLayer />
      {children}
    </div>
  );
}
