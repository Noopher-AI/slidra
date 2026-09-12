import type { CanvasController } from "../../../canvas.js";
import { contrastFill } from "../../../contrast-fill.js";

export interface ShapeMenuProps {
  onClose(): void;
  controller: CanvasController | null;
  /** The presentation's own canvas size — every geometry below is a percentage of THIS, never a hard-coded 1280×720 (same rule as `TextPanel`/`TablePanel`). `null` before it has loaded, which disables every item. */
  canvasSize: { width: number; height: number } | null;
  /** `null` before a slide has loaded, which disables every item. */
  slidePath: string | null;
  /** The current slide's own page style — `pageStyle.accent`, when set, fills rect/ellipse and strokes the line (unchanged). Without an accent, rect/ellipse `fill` and line `stroke` both come from `contrastFill(pageStyle?.background ?? null)` instead — never omitted, never a design-token fallback. `null` pageStyle (no slide, or the slide declares no page style) reaches `contrastFill` as a `null` background, which reads as white. */
  pageStyle: { background: string | null; accent: string | null } | null;
}

type ShapeKind = "rect" | "ellipse" | "line";

const SHAPE_ITEMS: { kind: ShapeKind; label: string }[] = [
  { kind: "rect", label: "Rectangle" },
  { kind: "ellipse", label: "Ellipse" },
  { kind: "line", label: "Line" },
];

/** Percentage geometry from `newShape()` (docs/design/prototype/comotion-logic-v3.js:186), converted against the presentation's own real canvas size. */
const RECT_BOX = { l: 36, t: 32, w: 28, h: 36 };

/**
 * Shape menu: Rectangle / Ellipse / Line, each item sends `element insert`
 * directly on click without opening a second-level panel. The menu always
 * closes after the command is sent — the same stance as `TablePanel`/
 * `TextPanel` — regardless of `runCommand`'s result; failures are already
 * handled through the existing `CanvasState.error` channel.
 */
export function ShapeMenu({ onClose, controller, canvasSize, slidePath, pageStyle }: ShapeMenuProps) {
  const canInsert = controller !== null && canvasSize !== null && slidePath !== null;

  async function insert(kind: ShapeKind): Promise<void> {
    if (!canInsert || !canvasSize || !slidePath) return;
    const x = (canvasSize.width * RECT_BOX.l) / 100;
    const y = (canvasSize.height * RECT_BOX.t) / 100;
    const width = (canvasSize.width * RECT_BOX.w) / 100;
    const height = (canvasSize.height * RECT_BOX.h) / 100;
    const accent = pageStyle?.accent ?? undefined;
    const fill = accent ?? contrastFill(pageStyle?.background ?? null);

    if (kind === "line") {
      await controller!.runCommand("element insert", {
        slidePath,
        kind: "line",
        x1: canvasSize.width * 0.2,
        y1: canvasSize.height * 0.5,
        x2: canvasSize.width * 0.8,
        y2: canvasSize.height * 0.5,
        stroke: fill,
        strokeWidth: 4,
      });
    } else {
      await controller!.runCommand("element insert", { slidePath, kind, x, y, width, height, fill });
    }
    onClose();
  }

  return (
    <div className="floating-layer dock-menu shape-menu" role="menu" aria-label="Shape">
      {SHAPE_ITEMS.map((item) => (
        <button
          key={item.kind}
          type="button"
          className="shape-menu-item"
          disabled={!canInsert}
          onClick={() => void insert(item.kind)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
