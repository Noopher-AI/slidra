/**
 * Style panel (§4.1-4.3): the eight attributes the panel exposes, and
 * the pure functions that read their current value off a `SlideElement` and
 * summarize them across a multi-selection. No DOM, no fetch — kept testable
 * in isolation and reusable from `StylePanel.tsx`.
 *
 * This list is this front end's OWN constant, not imported from core's
 * `STYLE_ATTRIBUTE_WHITELIST` (the command layer's real whitelist,
 * `packages/core/src/element-edit.ts`): the web bundle no longer depends on
 * core at all (F8, NOOP-289) — `SlideElement` now comes from this
 * package's own `slide-dom.ts`. Drift between this list and the real
 * whitelist is caught by `test/style-attrs.test.ts`, which reads
 * `docs/spec/cli.md`'s `element style set` entry directly.
 */
import type { SlideElement } from "./slide-dom.js";

export type PanelStyleAttribute =
  | "fill"
  | "stroke"
  | "stroke-width"
  | "font-family"
  | "font-size"
  | "font-weight"
  | "text-anchor"
  | "opacity";

/** Fixed order the panel renders its eight fields in. */
export const PANEL_STYLE_ATTRIBUTES: readonly PanelStyleAttribute[] = [
  "fill",
  "stroke",
  "stroke-width",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "opacity",
];

export type StyleReadResult = { kind: "value"; value: string } | { kind: "unset" } | { kind: "mixed" };

/**
 * Reads `attr`'s current value off a single element's primitives (§4.2).
 * Never invents a value: an attribute absent from every primitive is
 * `"unset"`, not the SVG spec's own default (`fill`'s default is black, but
 * claiming that here would be a fabricated value nobody actually wrote).
 * Values are returned verbatim — no normalization (`#FFF` stays `#FFF`).
 */
export function readElementStyle(element: SlideElement, attr: string): StyleReadResult {
  if (element.primitives.length === 0) {
    // Group container: no primitive carries any attribute at all.
    return { kind: "unset" };
  }
  let value: string | undefined;
  let sawUnset = false;
  let sawValue = false;
  for (const primitive of element.primitives) {
    const primitiveValue = primitive.attrs.get(attr);
    if (primitiveValue === undefined) {
      sawUnset = true;
      continue;
    }
    sawValue = true;
    if (value === undefined) {
      value = primitiveValue;
    } else if (value !== primitiveValue) {
      return { kind: "mixed" };
    }
  }
  if (sawValue && sawUnset) return { kind: "mixed" };
  if (sawValue && value !== undefined) return { kind: "value", value };
  return { kind: "unset" };
}

/**
 * Summarizes `attr` across every selected element (§4.3): a shared value
 * when all elements agree, `"unset"` when none of them set it, and
 * `"mixed"` for anything in between (including any element that is itself
 * internally mixed).
 */
export function summarizeSelection(elements: readonly SlideElement[], attr: string): StyleReadResult {
  if (elements.length === 0) return { kind: "unset" };
  let value: string | undefined;
  let sawUnset = false;
  let sawValue = false;
  for (const element of elements) {
    const result = readElementStyle(element, attr);
    if (result.kind === "mixed") return { kind: "mixed" };
    if (result.kind === "unset") {
      sawUnset = true;
      continue;
    }
    sawValue = true;
    if (value === undefined) {
      value = result.value;
    } else if (value !== result.value) {
      return { kind: "mixed" };
    }
  }
  if (sawValue && sawUnset) return { kind: "mixed" };
  if (sawValue && value !== undefined) return { kind: "value", value };
  return { kind: "unset" };
}
