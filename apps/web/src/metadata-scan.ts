// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

/**
 * A hand-written, offset-carrying SVG scanner.
 *
 * Written as a scanner rather than `DOMParser` on purpose: notes/comments
 * written before the `xmlns:slidra` fix are still sitting on disk without
 * a bound namespace prefix, and `DOMParser().parseFromString(...,
 * "image/svg+xml")` treats an unbound prefix as a fatal parse error. A
 * byte-offset scanner has no notion of namespace binding at all, so it
 * reads old and new files identically — `apps/web/test/notes.test.ts`
 * pins this down for `<slidra:notes>`. Only what `notes.ts`/`comments.ts`
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
  return `line ${line}, column ${column}`;
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
    if (!name) throw new Error("attribute syntax error: cannot parse attribute name");

    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    if (svg[i] !== "=") throw new Error(`attribute syntax error: attribute ${name} is missing =`);
    i++;

    while (i < to && XML_WHITESPACE.test(svg[i])) i++;
    const quote = svg[i];
    if (quote !== '"' && quote !== "'") throw new Error(`attribute syntax error: value of attribute ${name} is not quoted`);
    i++;

    const valueStart = i;
    while (i < to && svg[i] !== quote) i++;
    if (i >= to) throw new Error(`attribute syntax error: quote of attribute ${name} is not closed`);
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
  if (!tag) throw new Error(`markup syntax error: ${describe(svg, start)} is not a valid tag`);

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
  if (k >= svg.length) throw new Error(`markup syntax error: ${describe(svg, start)}'s <${tag}> tag has no closing >`);

  const selfClosing = svg[k - 1] === "/";
  const attributes = scanAttributes(svg, j, selfClosing ? k - 1 : k);
  return { tag, attributes, selfClosing, contentStart: k + 1 };
}

/** Scans the whole document into a tree of elements carrying byte offsets. */
export function scanDocument(svg: string): ScannedNode[] {
  const { nodes, next } = scanNodes(svg, 0, null);
  if (next < svg.length) {
    throw new Error(`markup syntax error: ${describe(svg, next)} has an extra closing tag`);
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
      if (next === -1) throw new Error(`markup syntax error: comment or declaration in ${describe(svg, i)} has no end`);
      i = svg.indexOf("<", next);
      continue;
    }
    if (marker === "/") {
      const closeEnd = svg.indexOf(">", i);
      if (closeEnd === -1) throw new Error(`markup syntax error: closing tag in ${describe(svg, i)} has no closing >`);
      const closingName = svg.slice(i + 2, closeEnd).trim();
      if (parentTag === null) return { nodes, next: i, closeStart: i };
      if (closingName !== parentTag) {
        throw new Error(`markup syntax error: closing tag in ${describe(svg, i)} is </${closingName}>, but the currently open tag is <${parentTag}>`);
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

  if (parentTag !== null) throw new Error(`markup syntax error: <${parentTag}> has no matching closing tag`);
  return { nodes, next: svg.length, closeStart: svg.length };
}

// --- Comments (`<slidra:comment>`) — read-only: the browser never writes metadata back ---

const COMMENTS_TAG = "slidra:comments";
const COMMENT_TAG = "slidra:comment";
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
    throw new Error("comment missing required attribute");
  }
  const raw = svgContent.slice(node.contentStart, node.contentEnd);
  return { id, target, author, created, text: unescapeXmlText(raw) };
}

/** Reads out a slide's comments in document order. A missing `<metadata>`, a missing `<slidra:comments>`, and an empty list all read the same: `[]`. */
export function readSlideComments(svgContent: string): SlideComment[] {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) throw new Error("root node of the slide is not <svg>");
  const list = findCommentsList(svgRoot);
  if (!list) return [];
  return list.children.filter((child) => child.tag === COMMENT_TAG).map((child) => readComment(child, svgContent));
}
