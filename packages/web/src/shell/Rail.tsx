import type { RefObject } from "react";

export interface RailProps {
  /** overview.ts 掛載用的容器。App 只掛一次，React 不再渲染其內容（ADR-0001/0002）。 */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * The thumbnail rail (#52). `overview.ts` — a vanilla DOM module, same trust
 * posture as canvas.ts — mounts the real thumbnail list into this container
 * once and owns everything inside it from then on; React never re-renders
 * into it (ADR-0001/ADR-0002). Page numbers and the current-slide outline
 * are generated inside overview.ts's own rebuildList()/updateHighlight(),
 * not duplicated here.
 */
export function Rail({ containerRef }: RailProps) {
  return <aside className="overview" ref={containerRef} />;
}
