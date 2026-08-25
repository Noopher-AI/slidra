import type { ReactNode, RefObject } from "react";
import type { CanvasController, CanvasState } from "../canvas.js";
import type { ShellView } from "./view.js";

export interface StageProps {
  /** canvas.ts 掛載 iframe 的容器。這個 DOM 節點的身分與位置永遠不能變。 */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** 舞台底＝全螢幕目標＝播放黑幕容器。class 必須含 `canvas-area`（#29 契約）。 */
  wellRef: RefObject<HTMLDivElement | null>;
  /** 舞台比例來源；null 時吃 CSS 的 16/9 fallback。 */
  canvasSize: { width: number; height: number } | null;
  /** 整包傳：#50/#56 在 CanvasState 上加欄位時，App.tsx 不必打開。 */
  state: CanvasState;
  controller: CanvasController | null;
  /** #55 在這裡加 `view === "grid"` 分支渲染 GridView，App.tsx 不必打開。 */
  view: ShellView;
  /** 播放通知與 PlayChrome。必須渲染在全螢幕目標之內，否則全螢幕時點不到。 */
  children?: ReactNode;
}

/**
 * The stage (#50 will replace this wholesale — see the ticket boundary
 * note in the PR body). `canvasSize`/`state`/`controller`/`view` are
 * accepted now (frozen seam) but not yet used to draw anything beyond the
 * pre-existing flex-filled canvas — #29's fullscreen behaviour contract
 * requires the iframe to grow to the *screen's own* dimensions
 * (e2e/player-fullscreen.test.ts asserts `frameSize[0] === screenSize[0]`),
 * which an aspect-ratio-letterboxed `.well`/`.stage` frame would violate;
 * that framing is left for #50, which owns re-deriving the fullscreen
 * behaviour together with the new stage design. `canvasRef`'s own div
 * never moves position across renders (`view === "grid"` has nothing to
 * branch into yet — #55 adds `GridView` here without reopening App.tsx).
 */
export function Stage({ canvasRef, wellRef, children }: StageProps) {
  return (
    <div className="canvas-area" ref={wellRef}>
      <div ref={canvasRef} className="canvas" />
      {children}
    </div>
  );
}
