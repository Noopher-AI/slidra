import { CoMotionError } from "../errors.js";

/**
 * A hand-written, offset-carrying SVG scanner. This is the one SVG scanner
 * in the codebase (#92) — every module that needs to know what elements a
 * slide document contains, whether to read attribute values or to splice
 * around an element's byte offsets, goes through `scanDocument` here.
 *
 * ## Rules it follows
 *
 * 1. `<!-- -->`, `<![CDATA[ ]]>`, `<? ?>` and `<!DOCTYPE [...]>` are always
 *    skipped to their proper terminator, so markup written inside them is
 *    never read as markup.
 * 2. Quote state is tracked while looking for a tag's `>`, so a `>` inside
 *    a quoted value (`d="M10 10 L20>20"`) never ends the tag early.
 * 3. The attribute region is tokenised character by character into
 *    name/value pairs, never searched as text — `data-note=' id="el-a"'`
 *    contains a value, not an `id` attribute.
 * 4. Syntax it cannot make sense of throws `CoMotionError`. It never guesses.
 *
 * When a tag carries more than one attribute of the same name (e.g.
 * `<text id="a" id="b">`), `attributeOf`/`attributeValue` resolve to the
 * *first* one — `Array.find` over `attributes`, which is built in document
 * order. Every caller relies on this same first-wins rule.
 *
 * Like the rest of `slide/` and `geometry/`, this module imports no Node
 * built-in module: the slide model has to be computable in a browser too.
 */

/** One attribute, with the byte span it occupies inside the document. */
export interface ScannedAttribute {
  name: string;
  value: string;
  /** Offset of the first character of the attribute name, in the whole document. */
  start: number;
  /** Offset just past the attribute value's closing quote, in the whole document. */
  end: number;
}

export interface ScannedNode {
  /** Tag name exactly as written. */
  tag: string;
  attributes: ScannedAttribute[];
  /** Offset of the element's opening `<`. */
  start: number;
  /** Offset just past the element's last character (`>` of the close tag, or of the self-closing tag). */
  end: number;
  /** Offset just past the opening tag's `>`. Equals `end` for a self-closing element. */
  contentStart: number;
  /** Offset of the closing tag's `<`. Equals `end` for a self-closing element. */
  contentEnd: number;
  selfClosing: boolean;
  children: ScannedNode[];
}

export function attributeOf(element: ScannedNode, name: string): ScannedAttribute | undefined {
  return element.attributes.find((attribute) => attribute.name === name);
}

export function attributeValue(element: ScannedNode, name: string): string | null {
  return attributeOf(element, name)?.value ?? null;
}

/** 1-based line and column of a document offset, for error messages. */
export function positionAt(svg: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < svg.length; i++) {
    if (svg[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

const XML_WHITESPACE = /[\t\n\r ]/;

/** Rule 1: skip a `<!...>` / `<?...>` construct, returning the offset just past it. */
function skipNonElementConstruct(svg: string, i: number): number {
  if (svg.startsWith("<!--", i)) {
    const end = svg.indexOf("-->", i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (svg.startsWith("<![CDATA[", i)) {
    const end = svg.indexOf("]]>", i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (svg[i + 1] === "?") {
    const end = svg.indexOf("?>", i + 2);
    return end === -1 ? -1 : end + 2;
  }
  let k = i + 2;
  let depth = 0;
  while (k < svg.length) {
    const ch = svg[k];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth <= 0) return k + 1;
    k++;
  }
  return -1;
}

/** Rule 3: tokenise an attribute region into name/value pairs with absolute offsets. */
function scanAttributes(svg: string, from: number, to: number): ScannedAttribute[] {
  const attributes: ScannedAttribute[] = [];
  let i = from;
  while (i < to) {
    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    if (i >= to) break;

    const nameStart = i;
    while (i < to && !XML_WHITESPACE.test(svg[i]) && svg[i] !== "=") i++;
    const name = svg.slice(nameStart, i);
    if (!name) {
      throw new CoMotionError("屬性語法錯誤：無法解析屬性名稱");
    }

    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    if (svg[i] !== "=") {
      throw new CoMotionError(`屬性語法錯誤：屬性 ${name} 缺少 =`);
    }
    i++;

    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    const quote = svg[i];
    if (quote !== '"' && quote !== "'") {
      throw new CoMotionError(`屬性語法錯誤：屬性 ${name} 的值未以引號括住`);
    }
    i++;

    const valueStart = i;
    while (i < to && svg[i] !== quote) i++;
    if (i >= to) {
      throw new CoMotionError(`屬性語法錯誤：屬性 ${name} 的引號未封閉`);
    }
    attributes.push({ name, value: svg.slice(valueStart, i), start: nameStart, end: i + 1 });
    i++;
  }
  return attributes;
}

interface OpenTag {
  tag: string;
  attributes: ScannedAttribute[];
  selfClosing: boolean;
  /** Offset just past the opening tag's `>`. */
  contentStart: number;
}

/** Rule 2: find the opening tag's `>` with quote tracking, then tokenise its attributes. */
function readOpenTag(svg: string, start: number): OpenTag {
  let j = start + 1;
  while (j < svg.length && /[\w:.-]/.test(svg[j])) j++;
  const tag = svg.slice(start + 1, j);
  if (!tag) {
    throw new CoMotionError(`標記語法錯誤：${describe(svg, start)} 不是合法的標籤`);
  }

  let k = j;
  let quote: string | null = null;
  while (k < svg.length) {
    const ch = svg[k];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      break;
    }
    k++;
  }
  if (k >= svg.length) {
    throw new CoMotionError(`標記語法錯誤：${describe(svg, start)} 的 <${tag}> 標籤沒有結尾的 >`);
  }

  const selfClosing = svg[k - 1] === "/";
  const attributes = scanAttributes(svg, j, selfClosing ? k - 1 : k);
  return { tag, attributes, selfClosing, contentStart: k + 1 };
}

function describe(svg: string, offset: number): string {
  const { line, column } = positionAt(svg, offset);
  return `第 ${line} 行第 ${column} 欄`;
}

/**
 * Scans the whole document into a tree of elements carrying byte offsets.
 * Text, comments, CDATA, processing instructions and declarations are not
 * represented — only elements are — but every offset is an offset into the
 * original string, so a caller can always splice around them.
 */
export function scanDocument(svg: string): ScannedNode[] {
  const { nodes, next } = scanNodes(svg, 0, null);
  if (next < svg.length) {
    throw new CoMotionError(`標記語法錯誤：${describe(svg, next)} 出現多餘的結束標籤`);
  }
  return nodes;
}

/**
 * Scans sibling elements starting at `from` until the document ends or a
 * closing tag for `parentTag` is reached. Returns the siblings and the
 * offset just past the closing tag (or the end of input at the top level).
 */
function scanNodes(
  svg: string,
  from: number,
  parentTag: string | null,
): { nodes: ScannedNode[]; next: number; closeStart: number } {
  const nodes: ScannedNode[] = [];
  let i = svg.indexOf("<", from);
  while (i !== -1) {
    const marker = svg[i + 1];
    if (marker === "!" || marker === "?") {
      const next = skipNonElementConstruct(svg, i);
      if (next === -1) {
        throw new CoMotionError(`標記語法錯誤：${describe(svg, i)} 的註解或宣告沒有結尾`);
      }
      i = svg.indexOf("<", next);
      continue;
    }
    if (marker === "/") {
      const closeEnd = svg.indexOf(">", i);
      if (closeEnd === -1) {
        throw new CoMotionError(`標記語法錯誤：${describe(svg, i)} 的結束標籤沒有結尾的 >`);
      }
      const closingName = svg.slice(i + 2, closeEnd).trim();
      if (parentTag === null) {
        return { nodes, next: i, closeStart: i };
      }
      if (closingName !== parentTag) {
        throw new CoMotionError(
          `標記語法錯誤：${describe(svg, i)} 的結束標籤是 </${closingName}>，但目前開啟的是 <${parentTag}>`,
        );
      }
      return { nodes, next: closeEnd + 1, closeStart: i };
    }

    const open = readOpenTag(svg, i);
    if (open.selfClosing) {
      nodes.push({
        tag: open.tag,
        attributes: open.attributes,
        start: i,
        end: open.contentStart,
        contentStart: open.contentStart,
        contentEnd: open.contentStart,
        selfClosing: true,
        children: [],
      });
      i = svg.indexOf("<", open.contentStart);
      continue;
    }

    const inner = scanNodes(svg, open.contentStart, open.tag);
    nodes.push({
      tag: open.tag,
      attributes: open.attributes,
      start: i,
      end: inner.next,
      contentStart: open.contentStart,
      contentEnd: inner.closeStart,
      selfClosing: false,
      children: inner.nodes,
    });
    i = svg.indexOf("<", inner.next);
  }

  if (parentTag !== null) {
    throw new CoMotionError(`標記語法錯誤：<${parentTag}> 沒有對應的結束標籤`);
  }
  return { nodes, next: svg.length, closeStart: svg.length };
}
