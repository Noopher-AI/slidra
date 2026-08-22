import { readFile, writeFile } from "node:fs/promises";
import { CoMotionError } from "./errors.js";
import { readVirtualFile, resolveVirtualFilePath } from "./virtual-fs.js";
import type { ProjectJson } from "./presentation.js";

/**
 * The slide-mutation primitive behind `text set` (ADR-0002: `text set` must
 * be semantically clear, not a raw SVG edit). This module never parses and
 * re-serializes the SVG document — that would reflow the whole file and
 * violate the byte-identical invariant ticket #3 is built around (ADR-0001,
 * ADR-0004: SVG size is the per-turn token cost). Instead it locates the
 * target element's opening/closing tag by scanning the raw text and splices
 * only the substring between them.
 */

interface TagMatch {
  tagName: string;
  attrsText: string;
  selfClosing: boolean;
  /** Index of the character right after the tag's closing `>`. */
  contentStart: number;
}

/**
 * Tags whose content the module is willing to treat as editable text. This
 * is a whitelist, not a "not self-closing" heuristic: syntax alone (an
 * element happens to have a closing tag) does not imply it carries text —
 * `<rect>` and `<g>` are perfectly valid non-self-closing elements with no
 * text content. Only add a tag here once the app actually renders text
 * runs on it.
 */
const TEXT_BEARING_TAGS = new Set(["text"]);

/**
 * Finds the terminator of a `<!...>` / `<?...>` construct starting at `i`
 * (comment, CDATA section, processing instruction, or a declaration such as
 * `<!DOCTYPE ...>`) and returns the index right after it. Returns -1 if the
 * construct is never terminated, so the caller can stop scanning rather
 * than misreading markup inside it as a real element.
 */
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
  // Any other "<!" construct (e.g. <!DOCTYPE ...>). Track bracket depth so
  // a ">" inside an internal subset ("[...]") doesn't end it early.
  let k = i + 2;
  let depth = 0;
  while (k < svg.length) {
    const ch = svg[k];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth <= 0) {
      return k + 1;
    }
    k++;
  }
  return -1;
}

/**
 * Scans forward from `fromIndex` for the next start tag (opening or
 * self-closing). Skips closing tags; skips comments, CDATA sections,
 * processing instructions and doctype declarations to their proper
 * terminator so markup written inside them is never read as real markup.
 * Quoted attribute values are tracked so a `>` appearing inside a quoted
 * attribute (e.g. a `d` path string) never mistakenly ends the tag early.
 */
function findNextStartTag(svg: string, fromIndex: number): TagMatch | null {
  let i = svg.indexOf("<", fromIndex);
  while (i !== -1) {
    const marker = svg[i + 1];
    if (marker === "/") {
      i = svg.indexOf("<", i + 1);
      continue;
    }
    if (marker === "!" || marker === "?") {
      const next = skipNonElementConstruct(svg, i);
      if (next === -1) {
        return null;
      }
      i = svg.indexOf("<", next);
      continue;
    }

    let j = i + 1;
    while (j < svg.length && /[\w:.-]/.test(svg[j])) {
      j++;
    }
    const tagName = svg.slice(i + 1, j);
    if (!tagName) {
      i = svg.indexOf("<", i + 1);
      continue;
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
      return null;
    }

    const selfClosing = svg[k - 1] === "/";
    const attrsEnd = selfClosing ? k - 1 : k;
    const attrsText = svg.slice(j, attrsEnd);
    return { tagName, attrsText, selfClosing, contentStart: k + 1 };
  }
  return null;
}

/**
 * Extracts the exact value of an `id="..."` / `id='...'` attribute, if
 * present. The attribute name must begin at the start of the attribute
 * region or directly after XML whitespace, so `data-id="..."` or
 * `xml:id="..."` (real, different attributes) are never mistaken for `id`.
 */
function extractId(attrsText: string): string | undefined {
  const match = /(?:^|[\t\n\r ])id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrsText);
  if (!match) {
    return undefined;
  }
  return match[1] ?? match[2];
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The set of code points XML 1.0 permits in character data (spec production
// [2] Char). Anything outside this — control characters like U+0001 in
// particular — would make the document invalid SVG if written verbatim.
const XML_1_0_CHAR = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

function assertValidXmlText(newText: string): void {
  if (!XML_1_0_CHAR.test(newText)) {
    throw new CoMotionError("文字內容包含 XML 不允許的字元");
  }
}

/**
 * Replaces the text content of the element identified by `elementId` inside
 * `svgContent` with `newText`, and returns the full document with that one
 * substitution applied. Every other byte of `svgContent` is preserved
 * exactly — no reformatting, no attribute reordering, no re-indentation.
 *
 * Throws when `newText` contains a code point XML 1.0 forbids, when
 * `elementId` does not appear in the document (including when it only
 * appears inside a comment or CDATA section, which are never scanned as
 * markup), when the matched element's tag is not on the text-bearing
 * whitelist (e.g. `<rect>`, `<g>`, `<image>`), or when the matched element
 * is self-closing and therefore has no text content to replace.
 */
export function replaceElementText(svgContent: string, elementId: string, newText: string): string {
  assertValidXmlText(newText);

  let searchFrom = 0;
  let match = findNextStartTag(svgContent, searchFrom);
  while (match) {
    if (extractId(match.attrsText) === elementId) {
      if (!TEXT_BEARING_TAGS.has(match.tagName)) {
        throw new CoMotionError(`元素不是文字元素：${elementId}`);
      }
      if (match.selfClosing) {
        throw new CoMotionError(`元素沒有文字內容：${elementId}`);
      }
      const closeTag = `</${match.tagName}>`;
      const closeIndex = svgContent.indexOf(closeTag, match.contentStart);
      if (closeIndex === -1) {
        throw new CoMotionError(`元素沒有文字內容：${elementId}`);
      }
      return (
        svgContent.slice(0, match.contentStart) +
        escapeXmlText(newText) +
        svgContent.slice(closeIndex)
      );
    }
    searchFrom = match.contentStart;
    match = findNextStartTag(svgContent, searchFrom);
  }
  throw new CoMotionError(`找不到元素：${elementId}`);
}

async function assertIsSlide(workDir: string, virtualPath: string): Promise<void> {
  const raw = await readVirtualFile(workDir, "project.json");
  let project: ProjectJson;
  try {
    project = JSON.parse(raw) as ProjectJson;
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  if (!Array.isArray(project.slides) || !project.slides.includes(virtualPath)) {
    throw new CoMotionError(`不是投影片：${virtualPath}`);
  }
}

/**
 * Reads the slide at `slideVirtualPath` inside the presentation's work
 * directory, replaces the named element's text, and writes the result back
 * to the same real file. `slideVirtualPath` must both resolve to a real
 * file (ADR-0004, third layer — no path is trusted until the virtual tree
 * discovers it) and be listed in `project.json`'s `slides` array.
 */
export async function writeSlideElementText(
  workDir: string,
  slideVirtualPath: string,
  elementId: string,
  newText: string,
): Promise<void> {
  const realPath = await resolveVirtualFilePath(workDir, slideVirtualPath);
  await assertIsSlide(workDir, slideVirtualPath);

  let original: string;
  try {
    original = await readFile(realPath, "utf-8");
  } catch {
    // realPath is a real filesystem path inside the hidden work directory
    // (ADR-0004) — never quote it.
    throw new CoMotionError(`讀取投影片時發生錯誤：${slideVirtualPath}`);
  }

  const updated = replaceElementText(original, elementId, newText);

  try {
    await writeFile(realPath, updated, "utf-8");
  } catch {
    throw new CoMotionError(`寫入投影片時發生錯誤：${slideVirtualPath}`);
  }
}
