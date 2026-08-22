import { generateElementId } from "./id.js";
import type { ProjectJson } from "./project-json.js";

export const FORMAT_VERSION = 1;

export const SLIDE_FILE_NAME = "slides/001.svg";

// project-json.ts owns the type now (single source of truth alongside its
// structural validator); re-exported here so existing callers importing it
// from this module keep working.
export type { ProjectJson } from "./project-json.js";

export interface MinimalPresentationFiles {
  /** Relative path -> file content, ready to be written under a container root. */
  files: Record<string, string>;
}

/**
 * Builds the file set for a minimal presentation (ADR-0003 container shape):
 * project.json + slides/ + a single title slide.
 *
 * The slide SVG is deliberately hand-readable (ADR-0004): one title text
 * element, no base64, no generated path data, no repeated inline styles.
 */
export function buildMinimalPresentation(name: string): MinimalPresentationFiles {
  const project: ProjectJson = {
    formatVersion: FORMAT_VERSION,
    name,
    canvas: { width: 1280, height: 720 },
    slides: [SLIDE_FILE_NAME],
  };

  const titleElementId = generateElementId();
  const slideSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <text id="${titleElementId}" data-comot-name="標題" x="640" y="360" text-anchor="middle" font-size="48">${escapeXmlText(name)}</text>
</svg>
`;

  return {
    files: {
      "project.json": `${JSON.stringify(project, null, 2)}\n`,
      [SLIDE_FILE_NAME]: slideSvg,
    },
  };
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
