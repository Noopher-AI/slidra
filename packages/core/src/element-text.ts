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
 * Scans forward from `fromIndex` for the next start tag (opening or
 * self-closing). Skips closing tags, comments, processing instructions and
 * doctype declarations. Quoted attribute values are tracked so a `>`
 * appearing inside a quoted attribute (e.g. a `d` path string) never
 * mistakenly ends the tag early.
 */
function findNextStartTag(svg: string, fromIndex: number): TagMatch | null {
  let i = svg.indexOf("<", fromIndex);
  while (i !== -1) {
    const marker = svg[i + 1];
    if (marker === "/" || marker === "!" || marker === "?") {
      i = svg.indexOf("<", i + 1);
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

/** Extracts the exact value of an `id="..."` / `id='...'` attribute, if present. */
function extractId(attrsText: string): string | undefined {
  const match = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrsText);
  if (!match) {
    return undefined;
  }
  return match[1] ?? match[2];
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replaces the text content of the element identified by `elementId` inside
 * `svgContent` with `newText`, and returns the full document with that one
 * substitution applied. Every other byte of `svgContent` is preserved
 * exactly — no reformatting, no attribute reordering, no re-indentation.
 *
 * Throws when `elementId` does not appear in the document, or when the
 * matched element is self-closing (e.g. `<image/>`) and therefore has no
 * text content to replace.
 */
export function replaceElementText(svgContent: string, elementId: string, newText: string): string {
  let searchFrom = 0;
  let match = findNextStartTag(svgContent, searchFrom);
  while (match) {
    if (extractId(match.attrsText) === elementId) {
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
