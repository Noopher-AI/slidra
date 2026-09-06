import { readFile } from "node:fs/promises";
import { CoMotionError, pasteTableCells, parseCellAnchor } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface TableCellPasteInput {
  id: string;
  slidePath: string;
  elementId: string;
  /** `r,c`, parsed by `@co-motion/core`'s `parseCellAnchor`. */
  at: string;
  /** TSV content. When absent, `tsvFile` is read instead — same posture as `element paste`'s `svg`/`svgFile`. */
  tsv?: string;
  /** CLI-only: a local filesystem path to read `tsv` from (`--tsv-file`). */
  tsvFile?: string;
}
export interface TableCellPasteData {
  cells: number;
}

export const tableCellPasteCommand: CommandHandler<TableCellPasteInput, TableCellPasteData> = async (input) => {
  const tsv = input.tsv ?? (input.tsvFile !== undefined ? await readTsvFile(input.tsvFile) : undefined);
  if (tsv === undefined) {
    throw new CoMotionError("table cell paste 缺少參數：tsv 或 tsvFile");
  }
  const { cells } = await pasteTableCells(input.id, input.slidePath, input.elementId, parseCellAnchor(input.at), tsv);
  return { ok: true, data: { cells }, message: `已貼上 ${cells} 個儲存格到 ${input.elementId}` };
};

async function readTsvFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    throw new CoMotionError(`找不到來源檔案：${filePath}`);
  }
}
