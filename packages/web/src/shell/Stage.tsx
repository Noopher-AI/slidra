import type { CSSProperties, ReactNode, RefObject } from "react";
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
  /** #55 用 `view` 決定 GridView 是否顯示；GridView 疊在這個子樹旁邊、絕不能取代它（見下方 render 內的說明），App.tsx 不必打開。 */
  view: ShellView;
  /** 播放通知與 PlayChrome。必須渲染在全螢幕目標之內，否則全螢幕時點不到。 */
  children?: ReactNode;
}

/**
 * The stage (#50): the slide sits centred inside `wellRef`'s element at the
 * presentation's own canvas ratio, auto-scaled to fit with margin and a
 * visible boundary (see styles/stage.css for the box itself and
 * styles/shell.css for `.canvas-area`'s well). This component only decides
 * the ratio (from `canvasSize`) and the DOM shape — all the fit/centre math
 * is CSS (`aspect-ratio` + `max-width`/`max-height`), so a window resize
 * recomputes for free with no JS involved.
 *
 * `canvasRef`'s div never moves position across renders, and the JSX below
 * is unconditional (no ternary/list wrapping it) so React never has reason
 * to give it a new node identity: canvas.ts's `mountCanvas` runs once and
 * holds that node forever, and recreating it silently orphans the mounted
 * iframe — no error, no failed assertion, the screen just goes white (see
 * the PR body's sabotage-proof evidence).
 *
 * #29's fullscreen contract (e2e/player-fullscreen.test.ts asserts
 * `frameSize[0] === screenSize[0]`) outranks this ticket's letterboxing —
 * `.canvas-area:fullscreen`/`.stage` in the two stylesheets above neutralise
 * the ratio frame under fullscreen, not this component.
 */
export function Stage({ canvasRef, wellRef, canvasSize, children }: StageProps) {
  // #55 (wave 4) reads `view` here, but must NOT branch on it with an early
  // `return <GridView ... />` before the JSX below: that swaps out the
  // unconditional JSX, which gives `canvasRef`'s div a new node identity.
  // canvas.ts's `mountCanvas` runs once and holds that node forever, and
  // App.tsx mounts it from an effect with a `[]` dependency array, so a
  // fresh `.canvas` div created by leaving and re-entering grid never gets
  // an iframe mounted into it — the centre goes white, nothing throws.
  // The safe shape: keep `.canvas-area`/`.stage`/`.canvas` mounted
  // unconditionally here and render GridView alongside them, hidden/overlaid
  // when `view !== "grid"` — the same posture App.tsx already uses for
  // `<Notes hidden={view === "grid"} />` — without reopening App.tsx.
  // #50 leaves `view` unused: this ticket only builds the standard-view stage.

  // `canvasSize` starts `null` until App.tsx's own `/api/presentation`
  // fetch resolves. stage.css's `.stage` carries a literal 16/9
  // `aspect-ratio` fallback for that window (docs/design/base-shell.html's
  // own template value); showing the box at that fallback ratio and then
  // jumping to the real one a moment later would be a visible flash for
  // any non-16:9 presentation, so the box is hidden (not `display: none`,
  // which would touch canvasRef's node's ancestor chain) until the real
  // ratio is known, then it appears already correct.
  const stageStyle: CSSProperties = canvasSize
    ? { aspectRatio: `${canvasSize.width} / ${canvasSize.height}` }
    : { visibility: "hidden" };

  return (
    <div className="canvas-area" ref={wellRef}>
      <div className="stage" style={stageStyle}>
        <div ref={canvasRef} className="canvas" />
      </div>
      {children}
    </div>
  );
}
