import { CoMotionError } from "../errors.js";
import {
  CONTAINER_ATTRIBUTES,
  SLIDE_PRIMITIVE_TAGS,
  checkSlideCompliance,
  type ComplianceCode,
} from "./format.js";
import { attributeOf, scanDocument, type ScannedAttribute, type ScannedNode } from "./scan.js";

/**
 * Normalisation: wrap bare primitives into containers, and move the
 * identifier, display name, media reference and transform up onto the
 * container (ADR-0012).
 *
 * Two things this module deliberately does NOT do:
 *
 * - It does not re-serialize the document. Every byte outside the spans it
 *   splices is preserved exactly, the same invariant `element-text.ts` was
 *   built around (ADR-0001, ADR-0004: SVG size is the per-turn token cost,
 *   and a reflowed file is a diff nobody can read).
 * - It does not hoist a primitive's native coordinates into the container's
 *   `transform` (軍令). `<g><rect x="0" y="0"/></g>` and
 *   `<g transform="translate(0 0)"><rect/></g>` render identically, but
 *   hoisting is only cheap for `rect`/`image`/`text` — for `line` it means
 *   recomputing `x2/y2`, and for `path` it means rewriting the whole `d`.
 *   A rule that only holds for three primitives is not a rule. So the
 *   container's `transform` is where editing commands write position and
 *   rotation, and the primitive's own coordinates stay its internal shape.
 *
 * That combination is what makes "the demo looks pixel-identical after
 * conversion" true by construction rather than by luck: wrapping an element
 * in a `<g>` with no transform changes no rendered geometry at all.
 *
 * No Node built-in imports, not even transitively — hence `generateId` is
 * injected rather than imported (`../id.js` reaches for Node's crypto module).
 */

export interface NormaliseResult {
  /** The normalised document. Byte-identical to the input when it was already compliant. */
  svg: string;
  /** How many new containers were wrapped this run. 0 means nothing changed. */
  wrapped: number;
  /** Identifiers minted for primitives that had none. */
  generatedIds: string[];
}

export interface NormaliseOptions {
  /**
   * Supplies an identifier for a primitive that carries none. Required, not
   * defaulted: core's own `generateElementId()` sits on Node's crypto module, and
   * importing it here would drag Node into a module the front end has to be
   * able to load.
   */
  generateId: () => string;
}

/** Problems conversion can repair. Everything else is the author's to fix first. */
const REPAIRABLE: ReadonlySet<ComplianceCode> = new Set<ComplianceCode>([
  "bare-primitive",
  "missing-id",
  "primitive-transform",
]);

const XML_WHITESPACE = /[\t\n\r ]/;

interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Normalises one slide. Throws when the slide has a problem conversion
 * refuses to repair — `<script>`, `<foreignObject>`, an unknown tag,
 * duplicate identifiers, broken markup — naming the line, so the author
 * fixes the real problem instead of getting a silently mangled file.
 */
export function normaliseSlideSvg(svg: string, options: NormaliseOptions): NormaliseResult {
  const issues = checkSlideCompliance(svg);
  const blocking = issues.find((issue) => !REPAIRABLE.has(issue.code));
  if (blocking) {
    throw new CoMotionError(
      `投影片不合規（第 ${blocking.line} 行第 ${blocking.column} 欄）：${blocking.message}轉換命令不會替你修這一項。`,
    );
  }
  if (issues.length === 0) {
    return { svg, wrapped: 0, generatedIds: [] };
  }

  const roots = scanDocument(svg);
  const svgRoot = roots.find((element) => element.tag === "svg")!;

  const usedIds = new Set<string>();
  collectIds(roots, usedIds);
  const generatedIds: string[] = [];
  const mintId = (): string => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = options.generateId();
      if (!id) throw new CoMotionError("轉換失敗：識別碼產生器回傳空字串");
      if (!usedIds.has(id)) {
        usedIds.add(id);
        generatedIds.push(id);
        return id;
      }
    }
    throw new CoMotionError("轉換失敗：連續 8 次產生的識別碼都與既有元素重複");
  };

  const splices: Splice[] = [];
  let wrapped = 0;

  for (const child of svgRoot.children) {
    if (SLIDE_PRIMITIVE_TAGS.includes(child.tag)) {
      splices.push(wrapPrimitive(svg, child, mintId));
      wrapped++;
      continue;
    }
    if (child.tag !== "g") continue;

    for (const container of containersNeedingWork(child)) {
      if (!attributeOf(container, "id")) {
        splices.push({
          start: container.start + 1 + container.tag.length,
          end: container.start + 1 + container.tag.length,
          text: ` id="${mintId()}"`,
        });
      }
      // A container holding a primitive that carries its own `transform` is
      // repaired by giving every one of its primitives a container of its
      // own — the container therefore becomes a group. One predictable rule
      // beats a special case for "the one primitive that had a transform".
      const primitives = container.children.filter((element) => SLIDE_PRIMITIVE_TAGS.includes(element.tag));
      if (primitives.some((element) => attributeOf(element, "transform"))) {
        for (const primitive of primitives) {
          splices.push(wrapPrimitive(svg, primitive, mintId));
          wrapped++;
        }
      }
    }
  }

  return { svg: applySplices(svg, splices), wrapped, generatedIds };
}

/** Every `<g>` at or below `root`, in document order. */
function containersNeedingWork(root: ScannedNode): ScannedNode[] {
  const containers: ScannedNode[] = [];
  const visit = (element: ScannedNode): void => {
    if (element.tag !== "g") return;
    containers.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return containers;
}

function collectIds(nodes: readonly ScannedNode[], into: Set<string>): void {
  for (const element of nodes) {
    const id = attributeOf(element, "id");
    if (id) into.add(id.value);
    collectIds(element.children, into);
  }
}

/**
 * Builds the replacement text that wraps one primitive in a container,
 * moving `id`, `data-comot-name`, `data-comot-media` and `transform` up
 * onto it. Every other attribute stays on the primitive, in its original
 * order and spacing, byte for byte.
 */
function wrapPrimitive(svg: string, element: ScannedNode, mintId: () => string): Splice {
  const lifted = new Map<string, string>();
  const removals: Array<{ start: number; end: number }> = [];
  for (const name of CONTAINER_ATTRIBUTES) {
    const attribute = attributeOf(element, name);
    if (!attribute) continue;
    lifted.set(name, attribute.value);
    removals.push({ start: startOfAttributeWithLeadingSpace(svg, element, attribute), end: attribute.end });
  }

  let primitiveText = svg.slice(element.start, element.end);
  for (const removal of [...removals].sort((left, right) => right.start - left.start)) {
    primitiveText =
      primitiveText.slice(0, removal.start - element.start) + primitiveText.slice(removal.end - element.start);
  }

  const indent = indentOfLineContaining(svg, element.start);
  const containerAttrs = CONTAINER_ATTRIBUTES.filter((name) => name === "id" || lifted.has(name))
    .map((name) => `${name}=${quote(name === "id" ? (lifted.get("id") ?? mintId()) : lifted.get(name)!)}`)
    .join(" ");

  return {
    start: element.start,
    end: element.end,
    text:
      `<g ${containerAttrs}>\n` +
      `${indent}  ${primitiveText.split("\n").join(`\n  `)}\n` +
      `${indent}</g>`,
  };
}

/** Quotes an attribute value without altering a single character of it. */
function quote(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new CoMotionError(`無法搬移含有兩種引號的屬性值：${value}`);
}

/** Where an attribute's removal should start, so the space in front of it goes too. */
function startOfAttributeWithLeadingSpace(
  svg: string,
  element: ScannedNode,
  attribute: ScannedAttribute,
): number {
  const tagNameEnd = element.start + 1 + element.tag.length;
  let start = attribute.start;
  while (start > tagNameEnd && XML_WHITESPACE.test(svg[start - 1])) start--;
  return start;
}

/** The leading whitespace of the line `offset` sits on, or "" when something else precedes it. */
function indentOfLineContaining(svg: string, offset: number): string {
  const lineStart = svg.lastIndexOf("\n", offset - 1) + 1;
  const prefix = svg.slice(lineStart, offset);
  return /^[\t ]*$/.test(prefix) ? prefix : "";
}

function applySplices(svg: string, splices: readonly Splice[]): string {
  let result = svg;
  for (const splice of [...splices].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}
