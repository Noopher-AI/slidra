import { parseFont, measureTextWidth, type FontMetrics } from "@co-motion/core/text-metrics";

// Thin browser wrapper around core's text-metrics.ts (ticket #71): the
// measurement algorithm itself lives entirely in the shared module so Node
// and browser reach byte-identical results — this file's only job is
// fetching font bytes over HTTP and caching the parsed result by URL.

const fontCache = new Map<string, Promise<FontMetrics>>();

/** Fetches and parses the font at `url` (e.g. "/api/raw/fonts/..."), caching by URL. */
export function loadFont(url: string): Promise<FontMetrics> {
  let cached = fontCache.get(url);
  if (!cached) {
    cached = fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`無法載入字型：HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => parseFont(new Uint8Array(buffer)));
    fontCache.set(url, cached);
  }
  return cached;
}

/** Loads the font at `url` (cached) and measures `text` at `fontSizePx`. */
export async function measureText(url: string, text: string, fontSizePx: number): Promise<number> {
  const font = await loadFont(url);
  return measureTextWidth(font, text, fontSizePx);
}
