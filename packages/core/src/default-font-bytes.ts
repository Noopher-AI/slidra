import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");

const DEFAULT_FONT_FILE = "fonts/NotoSansTC-Presentation.ttf";

/** The bytes behind `DEFAULT_FONT_FAMILY` (default-font.ts). Node only — never import this from the browser bundle. */
export function readDefaultFontBytes(): Uint8Array {
  return readFileSync(path.join(assetsDir, DEFAULT_FONT_FILE));
}
