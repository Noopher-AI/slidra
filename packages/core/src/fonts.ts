import { CoMotionError } from "./errors.js";
import { validateProjectJson, type FontEntry } from "./project-json.js";
import { readPresentationFile, readPresentationFileBytes } from "./workspace.js";
import { parseFont, measureTextWidth, type FontMetrics } from "./text-metrics.js";

export interface MeasurePresentationTextOptions {
  family: string;
  text: string;
  fontSizePx: number;
}

// Parsed fonts, keyed by "<presentation id>\0<family>". A presentation's
// embedded fonts never change within one process's lifetime (no font-import
// feature exists — see the plan's scope boundary), so caching the parsed
// FontMetrics avoids re-reading and re-parsing a multi-megabyte font file on
// every measurement call for the same presentation.
const fontCache = new Map<string, FontMetrics>();

/**
 * Measures `text` at `fontSizePx` using the font registered under `family`
 * in presentation `id`'s `project.json`. Throws if the presentation has no
 * `fonts` field, or none of its entries has that `family` — never falls
 * back to a system font or an arbitrary entry.
 */
export async function measurePresentationText(
  id: string,
  { family, text, fontSizePx }: MeasurePresentationTextOptions,
): Promise<number> {
  const font = await resolveFont(id, family);
  return measureTextWidth(font, text, fontSizePx);
}

/**
 * Resolves every font presentation `id` embeds, keyed by `family` — what
 * the text-box write path (`workspace.ts`'s `addTextBox`/`setElementText`/
 * `setTextBoxWidth`, #76) needs to pick the right font for whichever
 * `font-family` a given `<text>` node declares, and to hand `wrapText` a
 * `FontMetrics` it can call `measureTextWidth` against directly. Reuses
 * `resolveFont`'s own per-(id, family) cache, so a family resolved here and
 * one resolved through `measurePresentationText` never parse the same font
 * bytes twice.
 */
export async function resolvePresentationFonts(id: string): Promise<ReadonlyMap<string, FontMetrics>> {
  const raw = await readPresentationFile(id, "project.json");
  const project = validateProjectJson(JSON.parse(raw));
  const entries = project.fonts ?? [];
  const fonts = await Promise.all(entries.map((entry) => resolveFont(id, entry.family)));
  return new Map(entries.map((entry, i) => [entry.family, fonts[i]]));
}

async function resolveFont(id: string, family: string): Promise<FontMetrics> {
  const cacheKey = `${id}\0${family}`;
  const cached = fontCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const entry = await findFontEntry(id, family);
  const bytes = await readPresentationFileBytes(id, entry.file);
  const font = parseFont(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  fontCache.set(cacheKey, font);
  return font;
}

async function findFontEntry(id: string, family: string): Promise<FontEntry> {
  const raw = await readPresentationFile(id, "project.json");
  const project = validateProjectJson(JSON.parse(raw));
  const entry = project.fonts?.find((candidate) => candidate.family === family);
  if (!entry) {
    throw new CoMotionError(`簡報未內嵌字型：${family}`);
  }
  return entry;
}
