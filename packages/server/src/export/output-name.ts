import { sanitizeAssetBaseName } from "@co-motion/core";
import type { ExportFormat } from "./job.js";

/**
 * `<name>.pdf` for `pdf`, `<name>-frames.pdf` for `pdf-frames` — §4.3's
 * default `--out` naming, reused verbatim for the GUI job's own `fileName`
 * so a CLI export and a GUI export of the same presentation land on the
 * same name. `deckName` is `project.json`'s `name`, sanitized the same way
 * asset imports are (`sanitizeAssetBaseName` — never trusted verbatim into
 * a filesystem path).
 */
export function exportFileName(deckName: string, format: ExportFormat): string {
  const base = sanitizeAssetBaseName(deckName);
  return format === "pdf" ? `${base}.pdf` : `${base}-frames.pdf`;
}
