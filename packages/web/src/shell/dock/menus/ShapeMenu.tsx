import type { CanvasController } from "../../../canvas.js";

export interface ShapeMenuProps {
  onClose(): void;
  controller: CanvasController | null;
  /** The presentation's own canvas size — every geometry below is a percentage of THIS, never a hard-coded 1280×720 (same rule as `TextPanel`/`TablePanel`). `null` before it has loaded, which disables every item. */
  canvasSize: { width: number; height: number } | null;
  /** `null` before a slide has loaded, which disables every item. */
  slidePath: string | null;
  /** The current slide's own page style — `pageStyle.accent` fills rect/ellipse and strokes the line. `null` (no slide, or the slide declares no page style) is legal: rect/ellipse omit `--fill` and fall back to `element insert`'s own SVG default; `line` cannot do the same (an unstroked line renders as an invisible hole) so it falls back to a design-token accent instead. */
  pageStyle: { background: string | null; accent: string | null } | null;
}

type ShapeKind = "rect" | "ellipse" | "line";

const SHAPE_ITEMS: { kind: ShapeKind; label: string }[] = [
  { kind: "rect", label: "Rectangle" },
  { kind: "ellipse", label: "Ellipse" },
  { kind: "line", label: "Line" },
];

/** 原型 `newShape()`（docs/design/prototype/comotion-logic-v3.js:186）的百分比幾何, converted against the presentation's own real canvas size. */
const RECT_BOX = { l: 36, t: 32, w: 28, h: 36 };

/**
 * Reads the design package's own `--brand-red` token (same token
 * `canvas.ts`'s `selectionColors()` reads for the iframe's own accent) as
 * the line's fallback stroke when there is no page-style accent to use —
 * never a literal hex value, which `design-contract.test.ts` forbids
 * everywhere under `packages/web` except its own narrow exception list.
 */
function fallbackAccentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--brand-red").trim();
}

/**
 * Shape 選單（[E2.T17] plan §4.1）：Rectangle／Ellipse／Line 三個項目，點下去
 * 直接送 `element insert`，不開第二層面板（05-INTERACTIONS.feature:97-99）。
 * 命令送出後一律關閉選單——與 `TablePanel`/`TextPanel` 同一個姿態，不論
 * `runCommand` 的結果，失敗已經由既有的 `CanvasState.error` 通道處理。
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

    if (kind === "line") {
      await controller!.runCommand("element insert", {
        slidePath,
        kind: "line",
        x1: canvasSize.width * 0.2,
        y1: canvasSize.height * 0.5,
        x2: canvasSize.width * 0.8,
        y2: canvasSize.height * 0.5,
        stroke: accent ?? fallbackAccentColor(),
        strokeWidth: 4,
      });
    } else {
      await controller!.runCommand("element insert", { slidePath, kind, x, y, width, height, fill: accent });
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
