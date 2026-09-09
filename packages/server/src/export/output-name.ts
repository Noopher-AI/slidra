import type { ExportFormat } from "./job.js";

const ILLEGAL_FILESYSTEM_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/**
 * Ported verbatim from `packages/core`'s `asset-import.ts` ([E4.T9]/F7 —
 * this file's own private copy; the server no longer imports that
 * package). Strips the extension off a source name and replaces characters
 * an on-disk filename cannot contain with `_`, falling back to `"asset"`
 * only when nothing usable remains.
 */
function sanitizeAssetBaseName(sourceName: string): string {
  const withoutExtension = sourceName.replace(/\.[^./]+$/, "");
  const sanitized = withoutExtension.replace(ILLEGAL_FILESYSTEM_CHARS, "_").trim();
  return sanitized.length > 0 ? sanitized : "asset";
}

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
