/**
 * A hand-written, offset-carrying SVG scanner — the web's own copy of
 * core's `slide/scan.ts` scanDocument (F8, NOOP-289 決定 M1).
 *
 * Ported rather than replaced with `DOMParser` on purpose: notes/comments
 * written before core's `xmlns:comot` fix are still sitting on disk without
 * a bound namespace prefix, and `DOMParser().parseFromString(...,
 * "image/svg+xml")` treats an unbound prefix as a fatal parse error. A
 * byte-offset scanner has no notion of namespace binding at all, so it
 * reads old and new files identically — `apps/web/test/notes.test.ts`
 * pins this down for `<comot:notes>`. Only what `notes.ts`/`comments.ts`
 * actually need (element tree with byte offsets, first-wins attribute
 * lookup) is kept — no splicing helpers, since the browser never writes
 * metadata back.
 */

export interface ScannedAttribute {
  name: string;
  value: string;
  start: number;
  end: number;
}

export interface ScannedNode {
  tag: string;
  attributes: ScannedAttribute[];
  start: number;
  end: number;
  contentStart: number;
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

function positionAt(svg: string, offset: number): { line: number; column: number } {
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

function describe(svg: string, offset: number): string {
  const { line, column } = positionAt(svg, offset);
  return `第 ${line} 行第 ${column} 欄`;
}

const XML_WHITESPACE = /[\t\n\r ]/;

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

function scanAttributes(svg: string, from: number, to: number): ScannedAttribute[] {
  const attributes: ScannedAttribute[] = [];
  let i = from;
  while (i < to) {
    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    if (i >= to) break;

    const nameStart = i;
    while (i < to && !XML_WHITESPACE.test(svg[i]) && svg[i] !== "=") i++;
    const name = svg.slice(nameStart, i);
    if (!name) throw new Error("屬性語法錯誤：無法解析屬性名稱");

    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    if (svg[i] !== "=") throw new Error(`屬性語法錯誤：屬性 ${name} 缺少 =`);
    i++;

    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    const quote = svg[i];
    if (quote !== '"' && quote !== "'") throw new Error(`屬性語法錯誤：屬性 ${name} 的值未以引號括住`);
    i++;

    const valueStart = i;
    while (i < to && svg[i] !== quote) i++;
    if (i >= to) throw new Error(`屬性語法錯誤：屬性 ${name} 的引號未封閉`);
    attributes.push({ name, value: svg.slice(valueStart, i), start: nameStart, end: i + 1 });
    i++;
  }
  return attributes;
}

interface OpenTag {
  tag: string;
  attributes: ScannedAttribute[];
  selfClosing: boolean;
  contentStart: number;
}

function readOpenTag(svg: string, start: number): OpenTag {
  let j = start + 1;
  while (j < svg.length && /[\w:.-]/.test(svg[j])) j++;
  const tag = svg.slice(start + 1, j);
  if (!tag) throw new Error(`標記語法錯誤：${describe(svg, start)} 不是合法的標籤`);

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
  if (k >= svg.length) throw new Error(`標記語法錯誤：${describe(svg, start)} 的 <${tag}> 標籤沒有結尾的 >`);

  const selfClosing = svg[k - 1] === "/";
  const attributes = scanAttributes(svg, j, selfClosing ? k - 1 : k);
  return { tag, attributes, selfClosing, contentStart: k + 1 };
}

/** Scans the whole document into a tree of elements carrying byte offsets. */
export function scanDocument(svg: string): ScannedNode[] {
  const { nodes, next } = scanNodes(svg, 0, null);
  if (next < svg.length) {
    throw new Error(`標記語法錯誤：${describe(svg, next)} 出現多餘的結束標籤`);
  }
  return nodes;
}

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
      if (next === -1) throw new Error(`標記語法錯誤：${describe(svg, i)} 的註解或宣告沒有結尾`);
      i = svg.indexOf("<", next);
      continue;
    }
    if (marker === "/") {
      const closeEnd = svg.indexOf(">", i);
      if (closeEnd === -1) throw new Error(`標記語法錯誤：${describe(svg, i)} 的結束標籤沒有結尾的 >`);
      const closingName = svg.slice(i + 2, closeEnd).trim();
      if (parentTag === null) return { nodes, next: i, closeStart: i };
      if (closingName !== parentTag) {
        throw new Error(`標記語法錯誤：${describe(svg, i)} 的結束標籤是 </${closingName}>，但目前開啟的是 <${parentTag}>`);
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

  if (parentTag !== null) throw new Error(`標記語法錯誤：<${parentTag}> 沒有對應的結束標籤`);
  return { nodes, next: svg.length, closeStart: svg.length };
}

// --- 留言 (`<comot:comment>`) — web's own copy of core's `readSlideComments` (read-only: the browser never writes metadata back) ---

const COMMENTS_TAG = "comot:comments";
const COMMENT_TAG = "comot:comment";
const METADATA_TAG = "metadata";

export interface SlideComment {
  id: string;
  /** An element id, or the literal string `"page"`. */
  target: string;
  author: string;
  /** ISO 8601. */
  created: string;
  text: string;
}

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function findCommentsList(svgRoot: ScannedNode): ScannedNode | undefined {
  const metadata = svgRoot.children.find((child) => child.tag === METADATA_TAG);
  return metadata?.children.find((child) => child.tag === COMMENTS_TAG);
}

function readComment(node: ScannedNode, svgContent: string): SlideComment {
  const id = attributeValue(node, "id");
  const target = attributeValue(node, "target");
  const author = attributeValue(node, "author");
  const created = attributeValue(node, "created");
  if (id === null || target === null || author === null || created === null) {
    throw new Error("留言缺少必要屬性");
  }
  const raw = svgContent.slice(node.contentStart, node.contentEnd);
  return { id, target, author, created, text: unescapeXmlText(raw) };
}

/** Reads out a slide's comments in document order. A missing `<metadata>`, a missing `<comot:comments>`, and an empty list all read the same: `[]`. */
export function readSlideComments(svgContent: string): SlideComment[] {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) throw new Error("投影片的根節點不是 <svg>");
  const list = findCommentsList(svgRoot);
  if (!list) return [];
  return list.children.filter((child) => child.tag === COMMENT_TAG).map((child) => readComment(child, svgContent));
}
