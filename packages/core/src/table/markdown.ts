import { CoMotionError } from "../errors.js";
import type { CellAlign } from "./model.js";

/**
 * GitHub-flavored Markdown pipe table parsing (`table set --markdown`,
 * plan §4.2/§4.7). Header row, an alignment row (`:---`/`---:`/`:---:`),
 * then data rows. `\|` inside a cell is a literal pipe, never a column
 * separator.
 */

export interface ParsedMarkdownTable {
  headers: string[];
  /** Per-column alignment, from the alignment row; `"left"` when the row declares no opinion for that column. */
  aligns: CellAlign[];
  rows: string[][];
}

/** Splits one markdown table row into trimmed cells, honouring `\|` as a literal pipe and stripping the table's own leading/trailing `|`. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseAlignCell(cell: string): CellAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

const ALIGN_ROW_PATTERN = /^:?-+:?$/;

/**
 * Parses a GitHub-style pipe table. Requires at least a header row and an
 * alignment row; every data row's cell count must match the header's.
 */
export function parseMarkdownTable(text: string): ParsedMarkdownTable {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new CoMotionError("Markdown 表格至少需要標頭列與對齊列");
  }

  const headers = splitRow(lines[0]);
  const alignCells = splitRow(lines[1]);
  if (alignCells.length !== headers.length || !alignCells.every((cell) => ALIGN_ROW_PATTERN.test(cell))) {
    throw new CoMotionError("Markdown 表格第二列必須是對齊列（例如 :---、---:、:---:）");
  }
  const aligns = alignCells.map(parseAlignCell);

  const rows = lines.slice(2).map((line, index) => {
    const cells = splitRow(line);
    if (cells.length !== headers.length) {
      throw new CoMotionError(`Markdown 表格第 ${index + 3} 列的欄數（${cells.length}）與標頭（${headers.length}）不符`);
    }
    return cells;
  });

  return { headers, aligns, rows };
}
