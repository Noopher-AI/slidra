import { Icon } from "../../icons/index.js";

export interface HandButtonProps {
  /** stage-view.ts's `HandState.hand` — the button's own sticky toggle, not `isHandActive` (Space held is a separate, temporary state the button never reflects as pressed). */
  active: boolean;
  onToggle(): void;
}

/** Toggles hand/grab mode. */
export function HandButton({ active, onToggle }: HandButtonProps) {
  return (
    <button
      type="button"
      className="dock-hand-button"
      title="Hand tool · drag to pan (hold Space)"
      aria-label="Hand tool"
      aria-pressed={active}
      onClick={onToggle}
    >
      <Icon name="hand" size="command" />
    </button>
  );
}
