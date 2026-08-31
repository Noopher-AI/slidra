import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateElementId } from "./id.js";
import { DEFAULT_FONT_FAMILY } from "./default-font.js";
import type { FontEntry, ProjectJson } from "./project-json.js";

export const FORMAT_VERSION = 1;

export const SLIDE_FILE_NAME = "slides/001.svg";

// project-json.ts owns the type now (single source of truth alongside its
// structural validator); re-exported here so existing callers importing it
// from this module keep working.
export type { ProjectJson } from "./project-json.js";

export interface MinimalPresentationFiles {
  /** Relative path -> file content, ready to be written under a container root. */
  files: Record<string, string | Uint8Array>;
}

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");

const PRESENTATION_FONT_FAMILY = DEFAULT_FONT_FAMILY;
const PRESENTATION_FONT_FILE = "fonts/NotoSansTC-Presentation.ttf";
const PRESENTATION_FONT_LICENSE_FILE = "fonts/LICENSE-NotoSansTC.txt";

/**
 * Builds the file set for a minimal presentation (ADR-0003 container shape):
 * project.json + slides/ + a single title slide + the embedded presentation
 * font (ticket #71, ADR-0016) + its license text.
 *
 * The slide SVG is deliberately hand-readable (ADR-0004): one title text
 * element, no base64, no generated path data, no repeated inline styles. Its
 * `font-family` reference is the only thing that ties it to the embedded
 * font — no `@font-face`, no embedded font bytes. That is ADR-0016's
 * decision 2, not an oversight: `@font-face` is injected only by CoMotion's
 * wrapper documents (packages/web/src/canvas.ts), so this SVG opened alone
 * by an external tool degrades to a system font instead of being unreadable
 * or broken — legible, just not guaranteed pixel-identical to CoMotion.
 */
export function buildMinimalPresentation(name: string): MinimalPresentationFiles {
  const fonts: FontEntry[] = [
    {
      file: PRESENTATION_FONT_FILE,
      family: PRESENTATION_FONT_FAMILY,
      license: "SIL Open Font License 1.1",
      licenseFile: PRESENTATION_FONT_LICENSE_FILE,
      source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
    },
  ];

  const project: ProjectJson = {
    formatVersion: FORMAT_VERSION,
    name,
    canvas: { width: 1280, height: 720 },
    slides: [SLIDE_FILE_NAME],
    fonts,
  };

  const titleElementId = generateElementId();
  const slideSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <text id="${titleElementId}" data-comot-name="標題" x="640" y="360" text-anchor="middle" font-family="${PRESENTATION_FONT_FAMILY}" font-size="48">${escapeXmlText(name)}</text>
</svg>
`;

  return {
    files: {
      "project.json": `${JSON.stringify(project, null, 2)}\n`,
      [SLIDE_FILE_NAME]: slideSvg,
      [PRESENTATION_FONT_FILE]: readFileSync(path.join(assetsDir, "fonts/NotoSansTC-Presentation.ttf")),
      [PRESENTATION_FONT_LICENSE_FILE]: readFileSync(path.join(assetsDir, "fonts/LICENSE-NotoSansTC.txt")),
    },
  };
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
