import { useEffect, useRef } from "react";
import type { CanvasController } from "../canvas.js";
import { mountGridOverview, type OverviewController } from "../overview.js";
import type { ShellView } from "./view.js";

export interface GridViewProps {
  controller: CanvasController | null;
  /**
   * Called when a grid cell is clicked, to flip the centre column back to
   * "normal" (#55's 「點一格選到該頁並切回標準檢視」). Threaded straight
   * through from App.tsx's `setView`, via Stage.tsx (裁決 1, wave 5) — this
   * replaces a `window` CustomEvent bridge that only existed because
   * App.tsx was frozen for wave 4 and this prop path could not be opened
   * yet. That freeze does not apply to this ticket.
   */
  onViewChange: (view: ShellView) => void;
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
export function GridView({ controller, onViewChange }: GridViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !controller) return;
    const overview: OverviewController = mountGridOverview(container, controller, () => {
      onViewChange("normal");
    });
    return () => overview.destroy();
  }, [controller, onViewChange]);

  return <div className="grid-view" ref={containerRef} />;
}
