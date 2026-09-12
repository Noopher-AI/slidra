import { IDENTITY, multiplyMatrix, type Matrix } from "./geometry.js";

/**
 * Reads slide markup with the browser's own `DOMParser`, producing the
 * same slide-format shape `parseSlide`/`SlideModel` describes. Produces
 * the SAME type shape `canvas.ts` already consumes, but:
 *
 *  - no compliance check (`assertSlideCompliant` does not come along —
 *    the browser is a viewer now, not a gate; a slide it cannot make sense
 *    of yields `null`/throws and the caller degrades, per decision (e) in
 *    the plan);
 *  - no font-metrics-derived text bounds (`elementBounds` is not ported —
 *    geometry now comes from the runtime's own `getBBox()`/`getCTM()`);
 *  - `SlidePrimitive.runs` is always `[]` — the only consumer
 *    (`textboxPreviewMessage`'s local re-wrap/re-render) no longer exists
 *    once text editing lives entirely in the runtime (T1), so there is
 *    nothing left to populate it from or for.
 *
 * `DOMParser` decodes XML entities for free (`textContent`), so unlike the
 * byte-offset scanner this needs no separate unescape step.
 */

export interface TextRun {
  readonly start: number;
  readonly end: number;
  readonly fontWeight?: string;
  readonly fontStyle?: string;
}

export interface SlidePrimitive {
  tag: string;
  attrs: ReadonlyMap<string, string>;
  text: string;
  tspanCount: number;
  /** Always `[]` — see module doc comment. */
  runs: readonly TextRun[];
}

export type SlideElementKind =
  | "group"
  | "text"
  | "rect"
  | "ellipse"
  | "circle"
  | "line"
  | "image"
  | "path"
  | "compound"
  | "table"
  | "chart";

export interface SlideElement {
  id: string;
  name: string | null;
  media: string | null;
  kind: SlideElementKind;
  transform: string | null;
  matrix: Matrix;
  children: SlideElement[];
  primitives: SlidePrimitive[];
  textWidth: number | null;
  textHeight: number | null;
  textAlign: "left" | "center" | "right";
  /** `data-comot-lock="true"` — furniture the author cannot select or move (ADR-0013); today only the page background image. */
  locked: boolean;
  table: TableModel | null;
}

export interface PageStyle {
  background: string | null;
  accent: string | null;
}

/**
 * The page's background image (#303 §13), kept separate from `PageStyle`
 * on purpose — a background COLOR and a background IMAGE are independent
 * mechanisms (a page can have either, both, or neither), mirroring the
 * Rust side's own split between `facts.background` and
 * `facts.has_background` (`crates/comotion/src/validate/mod.rs`).
 */
export interface BackgroundImage {
  /** Virtual path from the presentation root, e.g. "assets/bg.svg" — the slide-relative "../" prefix stripped. */
  asset: string;
  opacity: number | null;
}

export interface SlideModel {
  viewBox: { x: number; y: number; width: number; height: number };
  elements: SlideElement[];
  pageStyle: PageStyle;
  backgroundImage: BackgroundImage | null;
}

export type TableTheme = "dark" | "light" | "zebra";
export const TABLE_THEMES: readonly TableTheme[] = ["dark", "light", "zebra"];

export type CellAlign = "left" | "center" | "right";

export interface TableCell {
  row: number;
  col: number;
  text: string;
  align: CellAlign;
  fill: string;
  fillOpacity: number | null;
  textFill: string;
  fontWeight: number;
  rowSpan: number;
  colSpan: number;
  repeat: boolean;
  generated: boolean;
}

export interface TableModel {
  cols: number[];
  rows: number[];
  header: boolean;
  theme: TableTheme;
  source: string | null;
  cells: TableCell[];
}

const TEXT_WIDTH_ATTRIBUTE = "data-comot-text-width";
const TEXT_HEIGHT_ATTRIBUTE = "data-comot-text-height";
const TEXT_ALIGN_ATTRIBUTE = "data-comot-text-align";
const CHART_CONTAINER_TYPE = "chart";
const TABLE_CONTAINER_TYPE = "table";
// `Element.localName` strips the namespace prefix (unlike core's
// byte-offset scanner, which never resolves namespaces at all and so
// keeps "comot:" on `ScannedNode.tag`) — the bare local name is what a
// DOMParser-parsed `<comot:source>` actually reports here.
const TABLE_SOURCE_TAG = "source";

const ARITY: Record<string, readonly number[]> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
};
const DEG_TO_RAD = Math.PI / 180;

/** Same grammar as core's geometry `parseTransform` — ported so a malformed transform degrades (see `toElement`'s catch) instead of taking the whole parse down with it. */
function parseTransform(value: string | null): Matrix {
  if (value === null) return IDENTITY;
  const text = value.trim();
  if (text === "") return IDENTITY;

  let result = IDENTITY;
  let i = 0;
  const isSeparator = (ch: string): boolean => ch === "," || /\s/.test(ch);

  while (i < text.length) {
    while (i < text.length && isSeparator(text[i])) i++;
    if (i >= text.length) break;
    const nameStart = i;
    while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    if (!name) throw new Error(`transform 語法錯誤：無法解析函式名稱（${text}）`);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "(") throw new Error(`transform 語法錯誤：${name} 後面缺少 (`);
    const close = text.indexOf(")", i);
    if (close === -1) throw new Error(`transform 語法錯誤：${name} 的括號未封閉`);
    const args = parseTransformArgs(name, text.slice(i + 1, close));
    i = close + 1;
    result = multiplyMatrix(result, transformFunctionToMatrix(name, args));
  }
  return result;
}

function parseTransformArgs(name: string, argsText: string): number[] {
  const arity = ARITY[name];
  if (!arity) throw new Error(`不支援的 transform 函式：${name}`);
  const tokens = argsText.split(/[\s,]+/).filter((token) => token.length > 0);
  const values = tokens.map((token) => {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
      throw new Error(`transform 語法錯誤：${name} 的參數不是數字（${token}）`);
    }
    return Number(token);
  });
  if (!arity.includes(values.length)) {
    throw new Error(`transform 語法錯誤：${name} 收到 ${values.length} 個參數，應為 ${arity.join(" 或 ")} 個`);
  }
  return values;
}

function transformFunctionToMatrix(name: string, args: number[]): Matrix {
  switch (name) {
    case "matrix":
      return { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    case "translate":
      return { a: 1, b: 0, c: 0, d: 1, e: args[0], f: args.length === 2 ? args[1] : 0 };
    case "scale": {
      const sx = args[0];
      const sy = args.length === 2 ? args[1] : sx;
      return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
    }
    case "rotate": {
      const radians = args[0] * DEG_TO_RAD;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (args.length === 1) return rotation;
      const [, cx, cy] = args;
      return multiplyMatrix(multiplyMatrix({ ...IDENTITY, e: cx, f: cy }, rotation), { ...IDENTITY, e: -cx, f: -cy });
    }
    case "skewX":
      return { a: 1, b: 0, c: Math.tan(args[0] * DEG_TO_RAD), d: 1, e: 0, f: 0 };
    case "skewY":
      return { a: 1, b: Math.tan(args[0] * DEG_TO_RAD), c: 0, d: 1, e: 0, f: 0 };
    default:
      throw new Error(`不支援的 transform 函式：${name}`);
  }
}

function childElements(node: Element): Element[] {
  return Array.from(node.children);
}

function localName(el: Element): string {
  return el.localName.toLowerCase();
}

function readTextAlign(container: Element): "left" | "center" | "right" {
  const raw = container.getAttribute(TEXT_ALIGN_ATTRIBUTE);
  if (raw === null) return "left";
  if (raw !== "left" && raw !== "center" && raw !== "right") {
    throw new Error(`元素 ${container.getAttribute("id")} 的 ${TEXT_ALIGN_ATTRIBUTE} 不是合法值：${raw}`);
  }
  return raw;
}

/** Rebuilds a `<text>`'s content string the same way `readTextBoxRuns` did: line tspans joined, a hard-break tspan (`data-comot-break="1"`) contributing a `\n`. Run styling (nested bold/italic tspans) is intentionally not tracked — see `SlidePrimitive.runs`'s doc comment. */
function readTextContent(textEl: Element): { text: string; tspanCount: number } {
  const lineTspans = childElements(textEl).filter((child) => localName(child) === "tspan");
  if (lineTspans.length === 0) {
    return { text: textEl.textContent ?? "", tspanCount: 0 };
  }
  let text = "";
  for (const line of lineTspans) {
    text += line.textContent ?? "";
    if (line.getAttribute("data-comot-break") === "1") text += "\n";
  }
  return { text, tspanCount: lineTspans.length };
}

function toPrimitive(child: Element): SlidePrimitive {
  const tag = localName(child);
  const attrs = new Map<string, string>();
  for (const attr of Array.from(child.attributes)) attrs.set(attr.name, attr.value);
  if (tag !== "text") {
    return { tag, attrs, text: "", tspanCount: 0, runs: [] };
  }
  const { text, tspanCount } = readTextContent(child);
  return { tag, attrs, text, tspanCount, runs: [] };
}

const IGNORED_CHILD_TAGS = new Set(["title", "desc"]);

function toElement(el: Element): SlideElement {
  const id = el.getAttribute("id") ?? "";
  const transform = el.getAttribute("transform");
  const children = childElements(el).filter((child) => !IGNORED_CHILD_TAGS.has(localName(child)));
  const isTable = el.getAttribute("data-comot-type") === TABLE_CONTAINER_TYPE;
  const isChart = el.getAttribute("data-comot-type") === CHART_CONTAINER_TYPE;
  const isGroup = !isTable && !isChart && children.length > 0 && children.every((child) => localName(child) === "g");

  const primitives: SlidePrimitive[] = isGroup || isTable || isChart ? [] : children.map(toPrimitive);

  let kind: SlideElementKind;
  if (isTable) kind = "table";
  else if (isChart) kind = "chart";
  else if (isGroup) kind = "group";
  else if (primitives.length === 1) kind = primitives[0].tag as SlideElementKind;
  else kind = "compound";

  // Decision (e): unlike core's own reader (which throws — a write-time
  // guarantee its writers must uphold), a bad `data-comot-text-width`/
  // `-height` here degrades to `null` (== "not a text box") rather than
  // failing the WHOLE slide's parse — the browser is a viewer now, and bad
  // data on one element should only cost that element's editability, not
  // every other element on the page.
  const textWidthRaw = el.getAttribute(TEXT_WIDTH_ATTRIBUTE);
  let textWidth: number | null = null;
  if (textWidthRaw !== null) {
    const value = Number(textWidthRaw.trim());
    if (textWidthRaw.trim() !== "" && Number.isFinite(value) && value > 0) textWidth = value;
  }

  const textHeightRaw = el.getAttribute(TEXT_HEIGHT_ATTRIBUTE);
  let textHeight: number | null = null;
  if (textHeightRaw !== null) {
    const value = Number(textHeightRaw.trim());
    if (textHeightRaw.trim() !== "" && Number.isFinite(value) && value > 0) textHeight = value;
  }

  return {
    id,
    name: el.getAttribute("data-comot-name"),
    media: el.getAttribute("data-comot-media"),
    kind,
    transform,
    matrix: parseTransform(transform),
    children: isGroup ? children.map(toElement) : [],
    primitives,
    textWidth,
    textHeight,
    textAlign: readTextAlign(el),
    locked: el.getAttribute("data-comot-lock") === "true",
    table: isTable ? readTableModel(el) : null,
  };
}

function requireEnum<T extends string>(value: string, domain: readonly T[], label: string): T {
  if (!(domain as readonly string[]).includes(value)) {
    throw new Error(`${label} 必須是下列其中之一：${domain.join("、")}（收到：${value}）`);
  }
  return value as T;
}

function parseNumberList(raw: string, elementId: string, attr: string): number[] {
  return raw
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error(`元素 ${elementId} 的 ${attr} 含非數字：${token}`);
      return value;
    });
}

function readCellText(cellEl: Element): string {
  const textEl = childElements(cellEl).find((child) => localName(child) === "text");
  if (!textEl) return "";
  const tspans = childElements(textEl).filter((child) => localName(child) === "tspan");
  if (tspans.length === 0) return "";
  return tspans
    .map((tspan) => (tspan.getAttribute("data-comot-break") === "1" ? `${tspan.textContent ?? ""}\n` : tspan.textContent ?? ""))
    .join("");
}

/** DOM version of core's table `readTableModel` — reads only (no `validateTableModel` write-time re-check: a table this loose to read is still shown, the CLI is what refuses to write one). A cell whose shape is unreadable is simply skipped rather than failing the whole slide parse. */
function readTableModel(container: Element): TableModel {
  const id = container.getAttribute("id") ?? "";
  const colsRaw = container.getAttribute("data-comot-cols");
  const rowsRaw = container.getAttribute("data-comot-rows");
  if (!colsRaw || !rowsRaw) throw new Error(`元素 ${id} 缺少 data-comot-cols 或 data-comot-rows`);
  const cols = parseNumberList(colsRaw, id, "data-comot-cols");
  const rows = parseNumberList(rowsRaw, id, "data-comot-rows");

  const header = container.getAttribute("data-comot-header") === "1";
  const theme = requireEnum(container.getAttribute("data-comot-theme") ?? "dark", TABLE_THEMES, `元素 ${id} 的 data-comot-theme`);

  const sourceEl = childElements(container).find((child) => localName(child) === TABLE_SOURCE_TAG);
  const source = sourceEl?.getAttribute("src") ?? null;

  const cellEls = childElements(container).filter((child) => child.hasAttribute("data-comot-cell"));
  const cells: TableCell[] = cellEls.map((cellEl) => {
    const address = /^(\d+),(\d+)$/.exec(cellEl.getAttribute("data-comot-cell")!);
    if (!address) throw new Error(`元素 ${id} 的儲存格位址格式錯誤：${cellEl.getAttribute("data-comot-cell")}`);
    const row = Number(address[1]);
    const col = Number(address[2]);

    const spanRaw = cellEl.getAttribute("data-comot-span");
    let rowSpan = 1;
    let colSpan = 1;
    if (spanRaw !== null) {
      const match = /^(\d+),(\d+)$/.exec(spanRaw);
      if (!match) throw new Error(`元素 ${id} 的 data-comot-span 格式錯誤：${spanRaw}`);
      rowSpan = Number(match[1]);
      colSpan = Number(match[2]);
    }

    const rectEl = childElements(cellEl).find((child) => localName(child) === "rect");
    const textEl = childElements(cellEl).find((child) => localName(child) === "text");
    const fill = rectEl?.getAttribute("fill") ?? "none";
    const fillOpacityRaw = rectEl?.getAttribute("fill-opacity") ?? null;
    const textFill = textEl?.getAttribute("fill") ?? "#000000";
    const fontWeightRaw = textEl?.getAttribute("font-weight") ?? null;
    const align = requireEnum(cellEl.getAttribute("data-comot-align") ?? "left", ["left", "center", "right"] as const, `儲存格 (${row},${col}) 的 data-comot-align`);

    return {
      row,
      col,
      text: readCellText(cellEl),
      align,
      fill,
      fillOpacity: fillOpacityRaw !== null ? Number(fillOpacityRaw) : null,
      textFill,
      fontWeight: fontWeightRaw !== null ? Number(fontWeightRaw) : 400,
      rowSpan,
      colSpan,
      repeat: cellEl.getAttribute("data-comot-repeat") === "row",
      generated: cellEl.getAttribute("data-comot-generated") === "1",
    };
  });

  return { cols, rows, header, theme, source, cells };
}

const BACKGROUND_PROPERTY = "background-color";
const ACCENT_PROPERTY = "--comot-accent";

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

function readPageStyle(svgRoot: Element): PageStyle {
  const declarations = parseStyleDeclarations(svgRoot.getAttribute("style"));
  return {
    background: declarations.get(BACKGROUND_PROPERTY) ?? null,
    accent: declarations.get(ACCENT_PROPERTY) ?? null,
  };
}

const BACKGROUND_ROLE_ATTRIBUTE = "data-comot-role";
const BACKGROUND_ROLE = "background";

/**
 * Finds the page's locked background `<g data-comot-role="background">`
 * and reads its `<image>`'s `href`/`opacity`, mirroring the Rust side's
 * `find_background` (`crates/comotion/src/slide/background.rs`). The href
 * is always written as `../assets/x.svg` (slides live in `slides/`) — the
 * `../` is stripped so callers get the same presentation-root-relative
 * path `slide background set --asset` and `/api/assets` both use.
 */
export function readBackgroundImage(svgRoot: Element): BackgroundImage | null {
  const g = childElements(svgRoot).find(
    (child) => localName(child) === "g" && child.getAttribute(BACKGROUND_ROLE_ATTRIBUTE) === BACKGROUND_ROLE,
  );
  if (!g) return null;
  const image = childElements(g).find((child) => localName(child) === "image");
  if (!image) return null;
  const href = image.getAttribute("href") ?? image.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  if (!href) return null;
  const asset = href.startsWith("../") ? href.slice(3) : href;
  const opacityRaw = image.getAttribute("opacity");
  const opacity = opacityRaw !== null ? Number(opacityRaw) : null;
  return { asset, opacity: opacity !== null && Number.isFinite(opacity) ? opacity : null };
}

/**
 * Parses slide markup into a `SlideModel`. Throws (never returns a partial
 * model) when the markup does not even parse as XML, has no `<svg>` root,
 * or the root has no legible `viewBox` — every call site already wraps
 * this in a try/catch and degrades (currentSlideModel = null), per the
 * plan's decision (e).
 */
export function parseSlide(svgMarkup: string): SlideModel {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("投影片的 SVG 標記無法解析");
  }
  const svgRoot = doc.documentElement;
  if (!svgRoot || localName(svgRoot) !== "svg") {
    throw new Error("投影片的根節點不是 <svg>");
  }
  const viewBoxText = svgRoot.getAttribute("viewBox");
  if (!viewBoxText) {
    throw new Error("投影片的根節點 <svg> 沒有 viewBox");
  }
  const parts = viewBoxText
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`投影片的 viewBox 不是四個數字：${viewBoxText}`);
  }
  const [x, y, width, height] = parts;

  const elements = childElements(svgRoot)
    .filter((child) => localName(child) === "g")
    .map(toElement);

  return {
    viewBox: { x, y, width, height },
    elements,
    pageStyle: readPageStyle(svgRoot),
    backgroundImage: readBackgroundImage(svgRoot),
  };
}
