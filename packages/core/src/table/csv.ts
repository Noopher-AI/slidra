import { CoMotionError } from "../errors.js";

/**
 * RFC 4180 CSV parsing shared by `asset import --as csv` and `table
 * bind`/`table refresh` (plan §4.3/§4.4). Quoted fields (comma/newline
 * inside a value), `""` escaping, `\r\n` and `\n` both accepted. No
 * `node:` imports — the front end may need this for local preview later.
 */

export interface ParsedTableCsv {
  headers: string[];
  /** One entry per data row, in the same order as `headers`. */
  rows: string[][];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits `text` into rows of fields, honouring RFC 4180 double-quote escaping (`""` -> `"`). */
function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) {
    throw new CoMotionError("CSV 語法錯誤：引號未封閉");
  }
  if (field !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}

/**
 * Parses a table-data CSV: header row is the column names (`{{ }}` keys);
 * every following row must have exactly the same number of fields. Blank
 * lines (no fields, or a single empty field) are dropped before
 * validation. Header cells must be non-empty and unique — a column name
 * is looked up by exact match, so a blank or duplicate name would make a
 * `{{ }}` binding ambiguous or unaddressable.
 */
export function parseTableCsv(text: string): ParsedTableCsv {
  const allRows = parseRows(stripBom(text)).filter((row) => !(row.length === 1 && row[0] === ""));
  if (allRows.length === 0) {
    throw new CoMotionError("CSV 沒有任何內容");
  }
  const [headers, ...dataRows] = allRows;

  const seen = new Set<string>();
  headers.forEach((header, index) => {
    if (header.trim() === "") {
      throw new CoMotionError(`CSV 標頭第 ${index + 1} 欄的欄名不可為空白`);
    }
    if (seen.has(header)) {
      throw new CoMotionError(`CSV 標頭欄名重複：${header}`);
    }
    seen.add(header);
  });

  dataRows.forEach((row, rowIndex) => {
    if (row.length !== headers.length) {
      throw new CoMotionError(
        `CSV 第 ${rowIndex + 2} 列的欄數（${row.length}）與標頭（${headers.length}）不符`,
      );
    }
  });

  return { headers, rows: dataRows };
}
