import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Shared close behavior for every floating layer this ticket adds (Dock's
 * insert panels / shape / arrange / zoom menus, Rail's New/Templates menu):
 * a `mousedown` (not `click`, per 02-DESIGN_DOC.md §4.3 "任一 mousedown 在
 * 外部 → 全關") outside the layer's own subtree closes it, and so does Esc.
 * Not exported from stage-view.ts — that module is deliberately pure/DOM-free
 * (used from Vitest with no DOM), and this hook is exactly the DOM-touching
 * half its own doc comment says callers own.
 *
 * `excludeRefs` should include both the floating layer's own root AND the
 * button that opens it — otherwise the button's own mousedown would count
 * as "outside", close the layer, and then its `click` handler's toggle
 * logic would immediately reopen it (the close never has a visible effect,
 * and a second real click needed to actually close it).
 */
export function useCloseFloatingLayer(
  active: boolean,
  excludeRefs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    function isInsideAny(target: Node): boolean {
      return excludeRefs.some((ref) => ref.current?.contains(target));
    }
    function onMouseDown(event: MouseEvent): void {
      if (!isInsideAny(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onClose]);
}
