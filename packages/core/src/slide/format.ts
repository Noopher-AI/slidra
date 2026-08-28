import { CoMotionError } from "../errors.js";
import { parseTransform, type Matrix } from "../geometry/transform.js";
import { MAX_CONTAINER_DEPTH } from "../geometry/bbox.js";
import { unescapeXmlText } from "../element-text.js";
import { attributeValue, positionAt, scanDocument, type ScannedNode } from "./scan.js";

/**
 * The single answer to "what is a compliant slide" (ADR-0012).
 *
 * The normal form: every element is one `<g>` container wrapping one or
 * more primitives; a group is a container of containers; the identifier and
 * the display name live on the container, never on the primitive; position
 * and rotation live in the container's `transform`, while size stays on the
 * primitive's own native attributes.
 *
 * Compliance is about STRUCTURE only. It does not judge whether an element
 * draws anything (a `<rect>` with no width is valid SVG that paints
 * nothing), and it does not sanitise: `on*` event handler attributes are
 * not checked here because ADR-0010/0011 put that defence in the iframe
 * sandbox, not in a scrubber.
 *
 * No Node built-in imports — the front end has to be able to run this too.
 */

/** Legal primitive tags (AC 4). `circle` is in because the demo deck uses it and it is a degenerate `ellipse`. */
export const SLIDE_PRIMITIVE_TAGS: readonly string[] = [
  "text",
  "rect",
  "ellipse",
  "circle",
  "line",
  "image",
  "path",
];

/** Explicitly illegal, and the convert command will NOT remove them for you (spec #70, ADR-0005). */
export const FORBIDDEN_TAGS: readonly string[] = ["foreignObject", "script"];

/** Direct children of `<svg>` that are document furniture rather than elements. */
const DOCUMENT_FURNITURE_TAGS = new Set(["defs", "style", "metadata", "title", "desc"]);

/** Accessibility children that may appear inside a container or a primitive and are ignored. */
const IGNORED_CHILD_TAGS = new Set(["title", "desc"]);

/** The only markup allowed inside a primitive, beyond the ignored accessibility children. */
const PRIMITIVE_CHILD_TAGS = new Set(["tspan"]);

/** Attributes the normal form keeps on the container, never on the primitive. */
export const CONTAINER_ATTRIBUTES: readonly string[] = [
  "id",
  "data-comot-name",
  "data-comot-media",
  "transform",
];

/** Appended to the issues `co-motion convert` can actually repair — never to the ones it refuses to touch. */
const CONVERT_HINT = "請執行 co-motion convert <簡報識別碼> 轉換成合規格式。";

// One source of truth for the nesting limit: the compliance check and the
// bounding-box walk must agree, or a slide could pass one and blow the
// other's call stack (ADR-0010: slide content is untrusted).
export { MAX_CONTAINER_DEPTH } from "../geometry/bbox.js";

export type SlideElementKind =
  | "group"
  | "text"
  | "rect"
  | "ellipse"
  | "circle"
  | "line"
  | "image"
  | "path"
  /** One container holding several primitives (ADR-0012 allows "one or more primitives"). */
  | "compound";

export interface SlidePrimitive {
  /** Tag name, lower-cased. */
  tag: string;
  /** Attributes exactly as written, unconverted. */
  attrs: ReadonlyMap<string, string>;
  /**
   * For a `<text>` primitive: its rendered text, decoded. When the `<text>`
   * carries `<tspan>` children (a text box's baked-in wrap, #76) this is
   * every tspan's content joined in document order — exactly the
   * concatenation `text/wrap.ts`'s line breaking guarantees is lossless.
   * Otherwise it is the `<text>`'s own direct content (the plain, legacy
   * shape `elementBounds` also has to support). `""` for every primitive
   * that is not `<text>`.
   */
  text: string;
  /**
   * For a `<text>` primitive carrying `<tspan>` children: how many there
   * are (the line count `elementBounds` needs for a text box's height). 0
   * for a plain `<text>` with no tspans, and for every primitive that is
   * not `<text>`.
   */
  tspanCount: number;
}

export interface SlideElement {
  id: string;
  /** `data-comot-name`; `null` when absent — conversion never invents a display name. */
  name: string | null;
  /** `data-comot-media`, verbatim (ADR-0005/0009: media is an attribute, not a kind). */
  media: string | null;
  kind: SlideElementKind;
  /** The container's `transform` attribute, verbatim; `null` when absent. */
  transform: string | null;
  /** `parseTransform(transform)`. */
  matrix: Matrix;
  /** Child containers when `kind === "group"`, otherwise empty. */
  children: SlideElement[];
  /** Primitives when `kind !== "group"`, otherwise empty. */
  primitives: SlidePrimitive[];
  /**
   * Parsed `data-comot-text-width`; `null` when the element is not a text
   * box. Lives on the container rather than the `<text>` primitive itself
   * (#76, W1-R1): `<text>` has no native size attribute, and the SVG 2
   * attribute that would be native (`inline-size`) is exactly the
   * browser-side wrapping #76 forbids computing at display time — there is
   * no third option. The ADR-0012 amendment this implies is recorded as
   * debt for a later documentation unit, not written here.
   */
  textWidth: number | null;
}

/** `data-comot-text-width`, see `SlideElement.textWidth`'s comment for why it lives here. */
export const TEXT_WIDTH_ATTRIBUTE = "data-comot-text-width";

export interface SlideModel {
  viewBox: { x: number; y: number; width: number; height: number };
  elements: SlideElement[];
}

export type ComplianceCode =
  | "bare-primitive"
  | "forbidden-tag"
  | "unknown-tag"
  | "missing-id"
  | "duplicate-id"
  | "empty-container"
  | "mixed-children"
  | "primitive-transform"
  | "bad-transform"
  | "missing-viewbox"
  | "too-deep"
  | "malformed-markup";

export interface ComplianceIssue {
  code: ComplianceCode;
  /** 1-based, pointing at the offending tag's `<`. */
  line: number;
  column: number;
  /** The offending tag name, or `null` when no tag corresponds. */
  tag: string | null;
  /** The related element identifier, when one is available. */
  elementId: string | null;
  /** Traditional Chinese, printable to a human as-is. */
  message: string;
}

/**
 * Reports every compliance problem in the slide, ordered by position in the
 * document. Pure inspection: it never throws for a non-compliant slide —
 * `assertSlideCompliant` is the layer that turns issues into an error.
 * Markup it cannot scan at all is reported as a single `malformed-markup`
 * issue rather than thrown, so the caller has one uniform shape to render.
 */
export function checkSlideCompliance(svg: string): ComplianceIssue[] {
  let roots: ScannedNode[];
  try {
    roots = scanDocument(svg);
  } catch (error) {
    return [
      {
        code: "malformed-markup",
        line: 1,
        column: 1,
        tag: null,
        elementId: null,
        message: error instanceof CoMotionError ? error.message : "投影片的 SVG 標記無法解析",
      },
    ];
  }

  const issues: ComplianceIssue[] = [];
  const at = (element: ScannedNode) => positionAt(svg, element.start);
  const report = (
    element: ScannedNode,
    code: ComplianceCode,
    message: string,
    elementId: string | null = null,
  ): void => {
    const { line, column } = at(element);
    issues.push({ code, line, column, tag: element.tag, elementId, message });
  };

  const svgRoot = roots.find((element) => element.tag === "svg");
  if (!svgRoot) {
    return [
      {
        code: "malformed-markup",
        line: 1,
        column: 1,
        tag: null,
        elementId: null,
        message: "投影片的根節點不是 <svg>",
      },
    ];
  }

  if (!attributeValue(svgRoot, "viewBox")) {
    report(svgRoot, "missing-viewbox", "根節點 <svg> 沒有 viewBox，投影片就沒有座標系。");
  }

  // <script> and <foreignObject> are illegal ANYWHERE in the document,
  // including inside <defs> and <metadata> (spec #70, ADR-0005), so this
  // sweep is separate from the structural walk below, which only visits
  // the element region.
  forEachNode(roots, (element) => {
    if (FORBIDDEN_TAGS.includes(element.tag)) {
      report(
        element,
        "forbidden-tag",
        `<${element.tag}> 不是合法元素，轉換命令不會替你移除，請自行刪除後再轉換。`,
      );
    }
  });

  const seenIds = new Set<string>();
  const noteId = (element: ScannedNode, id: string): void => {
    if (seenIds.has(id)) {
      report(element, "duplicate-id", `識別碼 ${id} 重複出現，每個元素的識別碼必須唯一。`, id);
      return;
    }
    seenIds.add(id);
  };

  const walkContainer = (element: ScannedNode, depth: number): void => {
    if (depth > MAX_CONTAINER_DEPTH) {
      report(element, "too-deep", `容器巢狀超過 ${MAX_CONTAINER_DEPTH} 層。`);
      return;
    }

    const id = attributeValue(element, "id");
    if (!id) {
      report(element, "missing-id", `容器 <g> 沒有 id，識別碼必須掛在容器上。${CONVERT_HINT}`);
    } else {
      noteId(element, id);
    }

    const transform = attributeValue(element, "transform");
    if (transform !== null) {
      try {
        parseTransform(transform);
      } catch (error) {
        report(
          element,
          "bad-transform",
          `容器${id ? ` ${id} ` : ""}的 transform 無法解析：${
            error instanceof Error ? error.message : String(error)
          }`,
          id,
        );
      }
    }

    const children = element.children.filter((child) => !IGNORED_CHILD_TAGS.has(child.tag));
    if (children.length === 0) {
      report(element, "empty-container", `容器${id ? ` ${id} ` : ""}裡沒有任何圖元或子容器。`, id);
      return;
    }

    const containers = children.filter((child) => child.tag === "g");
    const primitives = children.filter((child) => SLIDE_PRIMITIVE_TAGS.includes(child.tag));
    const others = children.filter(
      (child) => child.tag !== "g" && !SLIDE_PRIMITIVE_TAGS.includes(child.tag),
    );

    for (const other of others) {
      if (!FORBIDDEN_TAGS.includes(other.tag)) {
        reportUnknown(other);
      }
    }

    if (containers.length > 0 && primitives.length > 0) {
      report(element, "mixed-children", `容器${id ? ` ${id} ` : ""}同時含有圖元與子容器，容器只能二擇一。`, id);
    }

    for (const primitive of primitives) {
      walkPrimitive(primitive, id);
    }
    for (const container of containers) {
      walkContainer(container, depth + 1);
    }
  };

  const walkPrimitive = (element: ScannedNode, containerId: string | null): void => {
    if (attributeValue(element, "transform") !== null) {
      report(
        element,
        "primitive-transform",
        `<${element.tag}> 的 transform 寫在圖元上，位置與旋轉必須寫在容器的 transform 上。${CONVERT_HINT}`,
        containerId,
      );
    }
    for (const child of element.children) {
      if (IGNORED_CHILD_TAGS.has(child.tag) || PRIMITIVE_CHILD_TAGS.has(child.tag)) continue;
      if (FORBIDDEN_TAGS.includes(child.tag)) continue;
      reportUnknown(child);
    }
  };

  function reportUnknown(element: ScannedNode): void {
    report(
      element,
      "unknown-tag",
      `<${element.tag}> 不是合法的投影片元素，合法圖元為 ${SLIDE_PRIMITIVE_TAGS.join("、")}；` +
        "多邊形與折線請改用 <path>。",
    );
  }

  for (const child of svgRoot.children) {
    if (DOCUMENT_FURNITURE_TAGS.has(child.tag)) continue;
    if (FORBIDDEN_TAGS.includes(child.tag)) continue;
    if (child.tag === "g") {
      walkContainer(child, 1);
      continue;
    }
    if (SLIDE_PRIMITIVE_TAGS.includes(child.tag)) {
      report(child, "bare-primitive", `<${child.tag}> 是裸圖元，必須包在 <g> 容器裡。${CONVERT_HINT}`);
      const bareId = attributeValue(child, "id");
      if (bareId) noteId(child, bareId);
      walkPrimitiveChildrenOnly(child);
      continue;
    }
    reportUnknown(child);
  }

  function walkPrimitiveChildrenOnly(element: ScannedNode): void {
    for (const child of element.children) {
      if (IGNORED_CHILD_TAGS.has(child.tag) || PRIMITIVE_CHILD_TAGS.has(child.tag)) continue;
      if (FORBIDDEN_TAGS.includes(child.tag)) continue;
      reportUnknown(child);
    }
  }

  issues.sort((left, right) => left.line - right.line || left.column - right.column);
  return issues;
}

function forEachNode(nodes: readonly ScannedNode[], visit: (element: ScannedNode) => void): void {
  const stack = [...nodes];
  while (stack.length > 0) {
    const element = stack.pop()!;
    visit(element);
    stack.push(...element.children);
  }
}

/**
 * Throws unless the slide is compliant. This is the line every editing
 * command opens with (#73 onwards) — the whole point of AC 1 is that a
 * command tells the author exactly where the slide is wrong instead of
 * quietly coping with it.
 */
export function assertSlideCompliant(svg: string, slidePath: string): void {
  const issues = checkSlideCompliance(svg);
  if (issues.length === 0) return;
  const first = issues[0];
  const more = issues.length > 1 ? `（另有 ${issues.length - 1} 處問題）` : "";
  throw new CoMotionError(
    `投影片 ${slidePath} 不合規（第 ${first.line} 行第 ${first.column} 欄）：${first.message}${more}`,
  );
}

/** Parses a compliant slide into its model. A non-compliant slide throws exactly as `assertSlideCompliant` does. */
export function parseSlide(svg: string, slidePath = "投影片"): SlideModel {
  assertSlideCompliant(svg, slidePath);
  const roots = scanDocument(svg);
  const svgRoot = roots.find((element) => element.tag === "svg")!;
  const viewBoxText = attributeValue(svgRoot, "viewBox")!;
  const parts = viewBoxText.split(/[\s,]+/).filter((token) => token.length > 0).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new CoMotionError(`投影片 ${slidePath} 的 viewBox 不是四個數字：${viewBoxText}`);
  }
  const [x, y, width, height] = parts;

  const elements = svgRoot.children
    .filter((child) => child.tag === "g")
    .map((child) => toElement(child, svg));

  return { viewBox: { x, y, width, height }, elements };
}

/** Builds one `SlidePrimitive` from a scanned child node. `svg` is the whole document, needed to read a `<text>`'s content by its byte offsets. */
function toPrimitive(child: ScannedNode, svg: string): SlidePrimitive {
  const tag = child.tag.toLowerCase();
  const attrs = new Map(child.attributes.map((attribute) => [attribute.name, attribute.value]));
  if (tag !== "text") {
    return { tag, attrs, text: "", tspanCount: 0 };
  }
  const tspans = child.children.filter((grandchild) => grandchild.tag === "tspan");
  if (tspans.length > 0) {
    const text = tspans
      .map((tspan) => unescapeXmlText(svg.slice(tspan.contentStart, tspan.contentEnd)))
      .join("");
    return { tag, attrs, text, tspanCount: tspans.length };
  }
  const text = unescapeXmlText(svg.slice(child.contentStart, child.contentEnd));
  return { tag, attrs, text, tspanCount: 0 };
}

function toElement(element: ScannedNode, svg: string): SlideElement {
  const transform = attributeValue(element, "transform");
  const children = element.children.filter((child) => !IGNORED_CHILD_TAGS.has(child.tag));
  const isGroup = children.length > 0 && children.every((child) => child.tag === "g");

  const primitives: SlidePrimitive[] = isGroup
    ? []
    : children.map((child) => toPrimitive(child, svg));

  let kind: SlideElementKind;
  if (isGroup) kind = "group";
  else if (primitives.length === 1) kind = primitives[0].tag as SlideElementKind;
  else kind = "compound";

  const textWidthRaw = attributeValue(element, TEXT_WIDTH_ATTRIBUTE);
  let textWidth: number | null = null;
  if (textWidthRaw !== null) {
    const trimmed = textWidthRaw.trim();
    const value = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(value) || value <= 0) {
      throw new CoMotionError(
        `元素 ${attributeValue(element, "id")} 的 ${TEXT_WIDTH_ATTRIBUTE} 不是合法的正數：${textWidthRaw}`,
      );
    }
    textWidth = value;
  }

  return {
    id: attributeValue(element, "id")!,
    name: attributeValue(element, "data-comot-name"),
    media: attributeValue(element, "data-comot-media"),
    kind,
    transform,
    matrix: parseTransform(transform),
    children: isGroup ? children.map((child) => toElement(child, svg)) : [],
    primitives,
    textWidth,
  };
}
