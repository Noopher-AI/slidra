import { useRef } from "react";
import { useCloseFloatingLayer } from "../use-floating-layer.js";

export interface ContextMenuProps {
  /** `.stage-overlays`-relative px (already converted from the runtime's own client px by `OverlayLayer`). */
  point: { x: number; y: number };
  /** The overlay's own bounding box (well size), for the clamp formula below. */
  bounds: { width: number; height: number };
  onClose(): void;
  onDelete(): void;
  onDuplicate(): void;
  onOrder(direction: "up" | "down" | "front" | "back"): void;
}

/** Prototype's own clamp formula (`comotion-logic-v3.js:506`) — keeps the menu from being cut off near the right/bottom edge. */
const MENU_WIDTH = 240;
const MENU_HEIGHT = 340;

/**
 * Element right-click menu (NOOP-90/T2 §4.5, §3.10). Only the six items
 * this ticket owns — four Order + Duplicate + Delete — the other four
 * (Edit text / Style / Add animation / Comment to agent) belong to
 * NOOP-65/69/66/67 respectively, which add them to this same component.
 */
export function ContextMenu({ point, bounds, onClose, onDelete, onDuplicate, onOrder }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useCloseFloatingLayer(true, [rootRef], onClose);

  const left = Math.min(point.x, Math.max(0, bounds.width - MENU_WIDTH));
  const top = Math.min(point.y, Math.max(0, bounds.height - MENU_HEIGHT));

  function act(action: () => void): void {
    action();
    onClose();
  }

  return (
    <div ref={rootRef} className="floating-layer element-context-menu" role="menu" aria-label="Element" style={{ left, top }}>
      <button type="button" className="element-context-menu-item" role="menuitem" onClick={() => act(() => onOrder("front"))}>
        Bring to front<span className="element-context-menu-shortcut">⌘⇧]</span>
      </button>
      <button type="button" className="element-context-menu-item" role="menuitem" onClick={() => act(() => onOrder("up"))}>
        Bring forward<span className="element-context-menu-shortcut">⌘]</span>
      </button>
      <button type="button" className="element-context-menu-item" role="menuitem" onClick={() => act(() => onOrder("down"))}>
        Send backward<span className="element-context-menu-shortcut">⌘[</span>
      </button>
      <button type="button" className="element-context-menu-item" role="menuitem" onClick={() => act(() => onOrder("back"))}>
        Send to back<span className="element-context-menu-shortcut">⌘⇧[</span>
      </button>
      <span className="element-context-menu-divider" />
      <button type="button" className="element-context-menu-item" role="menuitem" onClick={() => act(onDuplicate)}>
        Duplicate<span className="element-context-menu-shortcut">⌘D</span>
      </button>
      <button type="button" className="element-context-menu-item element-context-menu-item-danger" role="menuitem" onClick={() => act(onDelete)}>
        Delete<span className="element-context-menu-shortcut">⌫</span>
      </button>
    </div>
  );
}
