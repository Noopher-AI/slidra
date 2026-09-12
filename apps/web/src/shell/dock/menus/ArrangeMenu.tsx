import type { CanvasController, CanvasSelection } from "../../../canvas.js";

export interface ArrangeMenuProps {
  selection: CanvasSelection;
  controller: CanvasController | null;
  onClose(): void;
}

const ALIGN_ITEMS: { direction: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"; label: string }[] = [
  { direction: "left", label: "Align left" },
  { direction: "hcenter", label: "Center horizontally" },
  { direction: "right", label: "Align right" },
  { direction: "top", label: "Align top" },
  { direction: "vcenter", label: "Center vertically" },
  { direction: "bottom", label: "Align bottom" },
];

const DISTRIBUTE_ITEMS: { axis: "horizontal" | "vertical"; label: string }[] = [
  { axis: "horizontal", label: "Distribute horizontally" },
  { axis: "vertical", label: "Distribute vertically" },
];

const ORDER_ITEMS: { direction: "front" | "up" | "down" | "back"; label: string; shortcut: string }[] = [
  { direction: "front", label: "Bring to front", shortcut: "⌘⇧]" },
  { direction: "up", label: "Bring forward", shortcut: "⌘]" },
  { direction: "down", label: "Send backward", shortcut: "⌘[" },
  { direction: "back", label: "Send to back", shortcut: "⌘⇧[" },
];

/**
 * Arrange menu — three columns: Align / Distribute / Order (§3.9). Its
 * disabled thresholds are more precise than the prototype's and match the
 * command layer (per the §3.9 decision): Align needs ≥2 selected elements
 * (a requirement of `element align` itself), Distribute needs ≥3 (a
 * requirement of `element distribute` itself), Order only needs ≥1
 * (`element order` is equally valid against a single target).
 */
export function ArrangeMenu({ selection, controller, onClose }: ArrangeMenuProps) {
  const count = selection.ids.length;
  const canAlign = count >= 2;
  const canDistribute = count >= 3;
  const canOrder = count >= 1;

  function align(direction: (typeof ALIGN_ITEMS)[number]["direction"]): void {
    if (!canAlign || !controller) return;
    void controller.alignSelection(direction);
  }
  function distribute(axis: (typeof DISTRIBUTE_ITEMS)[number]["axis"]): void {
    if (!canDistribute || !controller) return;
    void controller.distributeSelection(axis);
  }
  function order(direction: (typeof ORDER_ITEMS)[number]["direction"]): void {
    if (!canOrder || !controller) return;
    void controller.orderSelection(direction);
  }

  return (
    <div className="floating-layer dock-menu arrange-menu" role="menu" aria-label="Arrange">
      <div className="arrange-menu-column" role="group" aria-label="Align">
        {ALIGN_ITEMS.map((item) => (
          <button key={item.direction} type="button" className="arrange-menu-item" disabled={!canAlign} onClick={() => align(item.direction)}>
            {item.label}
          </button>
        ))}
      </div>
      <span className="arrange-menu-divider" />
      <div className="arrange-menu-column" role="group" aria-label="Distribute">
        {DISTRIBUTE_ITEMS.map((item) => (
          <button key={item.axis} type="button" className="arrange-menu-item" disabled={!canDistribute} onClick={() => distribute(item.axis)}>
            {item.label}
          </button>
        ))}
      </div>
      <span className="arrange-menu-divider" />
      <div className="arrange-menu-column" role="group" aria-label="Order">
        {ORDER_ITEMS.map((item) => (
          <button key={item.direction} type="button" className="arrange-menu-item" disabled={!canOrder} onClick={() => order(item.direction)}>
            {item.label}
            <span className="arrange-menu-shortcut">{item.shortcut}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
