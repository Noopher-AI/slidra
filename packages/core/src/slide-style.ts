import { CoMotionError } from "./errors.js";
import { applySplices, setAttrSplice } from "./element-text.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";

/**
 * Page style (#200 §4.4): background colour and accent colour, written as
 * CSS declarations on the slide's root `<svg>`'s own `style` attribute — a
 * single source of truth that is both machine-readable back (this module)
 * and actually paints (verified in a real Chromium: an inline `<svg
 * style="background-color:…">` computes that background, and a
 * `--comot-accent` custom property is readable via
 * `getPropertyValue`/`var()`). Not a `data-comot-*` attribute plus a
 * separate CSS rule (two places storing the same fact drift), and not a
 * background `<rect>` element (that would be selectable/deletable and show
 * up in the element list, which a page-level style must not).
 */
const BACKGROUND_PROPERTY = "background-color";
const ACCENT_PROPERTY = "--comot-accent";

function requireSvgRoot(svgContent: string): ScannedNode {
  const svgRoot = scanDocument(svgContent).find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

function parseStyleDeclarations(style: string | null): Map<string, string> {
  const declarations = new Map<string, string>();
  if (!style) return declarations;
  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    declarations.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
  }
  return declarations;
}

function serializeStyleDeclarations(declarations: ReadonlyMap<string, string>): string {
  return [...declarations.entries()].map(([property, value]) => `${property}:${value}`).join(";");
}

export interface PageStyle {
  /** `null` when the declaration is absent — never a fabricated default. */
  background: string | null;
  accent: string | null;
}

/** Reads a slide's Page style off its root `<svg>`'s `style` attribute (`slide/format.ts`'s `SlideModel.pageStyle` uses this). */
export function readSlidePageStyle(svgContent: string): PageStyle {
  const svgRoot = requireSvgRoot(svgContent);
  const declarations = parseStyleDeclarations(attributeValue(svgRoot, "style"));
  return {
    background: declarations.get(BACKGROUND_PROPERTY) ?? null,
    accent: declarations.get(ACCENT_PROPERTY) ?? null,
  };
}

export interface PageStyleUpdate {
  /** `""` clears the declaration; omitting the field leaves it untouched. */
  readonly background?: string;
  readonly accent?: string;
}

/**
 * Sets/clears the root `<svg>`'s Page style (`co-motion slide style set`,
 * #200 architecture — this call is meant to go through history, unlike
 * `presentation canvas set`). At least one of `background`/`accent` must be
 * given, mirroring `text style set`'s existing "at least one flag" rule
 * (`element-text.ts`'s `setTextRunStyle`).
 */
export function setSlidePageStyle(svgContent: string, update: PageStyleUpdate): string {
  if (update.background === undefined && update.accent === undefined) {
    throw new CoMotionError("命令 slide style set 至少要給 --background 或 --accent");
  }
  const svgRoot = requireSvgRoot(svgContent);
  const declarations = parseStyleDeclarations(attributeValue(svgRoot, "style"));

  if (update.background !== undefined) {
    if (update.background === "") declarations.delete(BACKGROUND_PROPERTY);
    else declarations.set(BACKGROUND_PROPERTY, update.background);
  }
  if (update.accent !== undefined) {
    if (update.accent === "") declarations.delete(ACCENT_PROPERTY);
    else declarations.set(ACCENT_PROPERTY, update.accent);
  }

  const nextStyle = serializeStyleDeclarations(declarations);
  if (nextStyle === "") {
    const existing = attributeOf(svgRoot, "style");
    if (!existing) return svgContent;
    const tagNameEnd = svgRoot.start + 1 + svgRoot.tag.length;
    let start = existing.start;
    while (start > tagNameEnd && /\s/.test(svgContent[start - 1])) start--;
    return applySplices(svgContent, [{ start, end: existing.end, text: "" }]);
  }
  return applySplices(svgContent, [setAttrSplice(svgRoot, "style", nextStyle)]);
}
