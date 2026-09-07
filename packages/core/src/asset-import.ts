import { CoMotionError } from "./errors.js";
import { detectMediaFormat, type MediaFormatEntry } from "./media-format.js";
import { parseTableCsv } from "./table/csv.js";

/**
 * Pure asset-import decisions (NOOP-90/T4, ADR-0015): what format a source's
 * bytes really are, and what filename to give the imported copy. No I/O —
 * reading the source (a local path or a URL) and writing the result into
 * `assets/` is the CLI command's job (`packages/cli/src/commands/asset-import.ts`).
 */

const ILLEGAL_FILESYSTEM_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/**
 * Strips the extension off a source filename and replaces characters an
 * on-disk filename cannot contain with `_`. Falls back to `"asset"` only
 * when the source name yields nothing usable at all (e.g. a URL with no
 * path segment) — not a fallback for a rejected format, just a name.
 */
export function sanitizeAssetBaseName(sourceName: string): string {
  const withoutExtension = sourceName.replace(/\.[^./]+$/, "");
  const sanitized = withoutExtension.replace(ILLEGAL_FILESYSTEM_CHARS, "_").trim();
  return sanitized.length > 0 ? sanitized : "asset";
}

/**
 * Resolves a conflict-free filename under `assets/`: `<baseName><extension>`
 * if free, otherwise `<baseName>-1<extension>`, `<baseName>-2<extension>`,
 * … up to the first name not already in `existingNames` (`docs/asset-import.md`).
 * Never overwrites, never uses a timestamp — the exact rule the plan
 * ratified in NOOP-96's comment.
 */
export function resolveConflictFreeFilename(
  baseName: string,
  extension: string,
  existingNames: readonly string[],
): string {
  const existing = new Set(existingNames);
  const candidate = `${baseName}${extension}`;
  if (!existing.has(candidate)) {
    return candidate;
  }
  let suffix = 1;
  while (existing.has(`${baseName}-${suffix}${extension}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}${extension}`;
}

export interface ResolveAssetImportInput {
  /** The source's filename or URL path segment, used only to derive the imported file's base name — never to decide its format. */
  sourceName: string;
  bytes: Uint8Array;
  /** Current entries of the presentation's `assets/` directory. */
  existingAssetNames: readonly string[];
}

export interface ResolvedAssetImport {
  format: MediaFormatEntry;
  /** The conflict-free filename to write under `assets/`. */
  fileName: string;
}

/**
 * Decides an asset import's outcome: detects the real format from the
 * bytes (never the source's claimed extension), then resolves a
 * conflict-free destination filename. Throws when the bytes match no
 * known media format — the only rejection this function raises, and the
 * only one asset import raises for "wrong content" (ADR-0015: no fallback
 * to octet-stream, no guessing from the extension).
 */
export function resolveAssetImport(input: ResolveAssetImportInput): ResolvedAssetImport {
  const format = detectMediaFormat(input.bytes);
  if (!format) {
    throw new CoMotionError("不支援的媒體格式：檔案內容不是已知的圖片、影片或音訊格式");
  }
  const baseName = sanitizeAssetBaseName(input.sourceName);
  const fileName = resolveConflictFreeFilename(baseName, format.extension, input.existingAssetNames);
  return { format, fileName };
}

// ---------------------------------------------------------------------------
// `asset import --as csv` (E2.T14, plan §0(c)/§4.3): a deliberate, explicit
// hole in ADR-0015's "no text files, ever" guard. Without `--as csv`,
// `resolveAssetImport` above is untouched byte-for-byte — this path only
// runs when the caller opts in.
// ---------------------------------------------------------------------------

const RESERVED_CSV_HEADER_NAMES = new Set(["slide_number", "slide_total", "presentation_name"]);
/** NUL and every C0 control code except \t (09) \n (0A) \r (0D) — CSV is data, not markup, but it is still text. */
const ILLEGAL_CSV_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

export interface ResolveDataAssetImportInput {
  /** The source's filename or URL path segment — must end in `.csv` (case-insensitive), never sniffed from content. */
  sourceName: string;
  bytes: Uint8Array;
  /** Current entries of the presentation's `assets/data/` directory. */
  existingAssetNames: readonly string[];
}

export interface ResolvedDataAssetImport {
  /** The conflict-free filename to write under `assets/data/`. */
  fileName: string;
}

/**
 * Decides a data-asset import's outcome (`--as csv`): the source name must
 * end in `.csv`, the bytes must decode as UTF-8 text free of stray control
 * characters, and the text must parse as a legal table CSV (RFC 4180,
 * non-empty unique header names, consistent column counts — `table/csv.ts`'s
 * `parseTableCsv` already enforces all of that) whose header does not
 * collide with a `{{ }}` dynamic-text reserved name. Nothing is ever
 * written when this throws.
 */
export function resolveDataAssetImport(input: ResolveDataAssetImportInput): ResolvedDataAssetImport {
  if (!/\.csv$/i.test(input.sourceName)) {
    throw new CoMotionError(`資料資產必須是 .csv 檔案：${input.sourceName}`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new CoMotionError("CSV 內容不是合法的 UTF-8 文字");
  }
  if (ILLEGAL_CSV_CONTROL_CHARS.test(text)) {
    throw new CoMotionError("CSV 內容不是合法的 UTF-8 文字");
  }

  const parsed = parseTableCsv(text);
  for (const header of parsed.headers) {
    if (RESERVED_CSV_HEADER_NAMES.has(header)) {
      throw new CoMotionError(`CSV 標頭不可使用保留名稱（與動態文字變數衝突）：${header}`);
    }
  }

  const baseName = sanitizeAssetBaseName(input.sourceName);
  const fileName = resolveConflictFreeFilename(baseName, ".csv", input.existingAssetNames);
  return { fileName };
}
