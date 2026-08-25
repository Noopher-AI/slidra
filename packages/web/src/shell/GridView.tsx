import { useEffect, useRef } from "react";
import type { CanvasController } from "../canvas.js";
import { mountGridOverview, type OverviewController } from "../overview.js";

/**
 * Fired on `window` when a grid cell is clicked (#55's 「點一格選到該頁並切
 * 回標準檢視」). GridView has no prop path back to App.tsx's `setView`:
 * `Stage.tsx` receives no `onViewChange` (裁決 5 only settles GridView's
 * render condition, `view === "grid" && state.mode !== "play"`, using the
 * `state` prop Stage already has — it does not add a callback prop), and
 * `App.tsx` is frozen for this ticket, so threading a new prop through it
 * is not an option. StatusBar.tsx already holds the one thing that *can*
 * flip `view` back — the `onViewChange` prop App.tsx wires to `setView` —
 * so this event is a narrow, explicit bridge between these two sibling
 * shell components instead. See StatusBar.tsx's own `window.addEventListener`
 * for the other half.
 */
export const GRID_EXIT_EVENT = "co-motion:grid-exit";

export interface GridViewProps {
  controller: CanvasController | null;
}

/**
 * #55's grid view: renders as an absolutely-positioned overlay inside
 * `Stage.tsx`'s `.canvas-area` (裁決 5), covering but never replacing the
 * `.stage` subtree, which `Stage.tsx` keeps mounted unconditionally.
 *
 * Unlike that `.stage` subtree, this component owns no long-lived
 * controller state an unmount would orphan — its thumbnail iframes are
 * plain lazy-loaded views of the deck, the same kind `overview.ts`'s
 * `mountOverview` already builds for the rail — so Stage.tsx is free to
 * mount/unmount this component with a plain conditional render each time
 * `view`/`state.mode` change, and a fresh `mountGridOverview` call here
 * rebuilds it from scratch every time, materialising thumbnails lazily
 * again from a clean slate.
 */
export function GridView({ controller }: GridViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !controller) return;
    const overview: OverviewController = mountGridOverview(container, controller, () => {
      window.dispatchEvent(new CustomEvent(GRID_EXIT_EVENT));
    });
    return () => overview.destroy();
  }, [controller]);

  return <div className="grid-view" ref={containerRef} />;
}
