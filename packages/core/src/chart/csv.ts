import { CoMotionError } from "../errors.js";

/**
 * `chart data set --csv` / `--csv-asset`'s parser (plan §4.3). RFC 4180
 * quoted fields (a series name may legally contain a comma), BOM-stripped
 * (CSV is data, not a document — unlike `slide-format.test.ts`'s "BOM kept
 * verbatim" rule for slide text), `\r\n` and `\n` both accepted, trailing
 * blank lines ignored. No `node:` imports: the front end's local preview
 * for a pasted CSV (should a later ticket want one) can reuse this.
 */

export interface ParsedChartCsv {
  categories: string[];
  series: { name: string; values: number[] }[];
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
  // A trailing newline leaves `field === "" && row.length === 0`, meaning
  // there is no partial final row to flush — only push one when there is
  // content pending.
  if (field !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}

/**
 * Parses a chart CSV: header row is `<category axis label>,<series 1
 * name>,<series 2 name>,…` (the first header cell is ignored — it only
 * labels the category column for the human editing the file); every
 * following row is `<category name>,<value 1>,<value 2>,…`. Blank lines
 * (no fields, or a single empty field) are dropped before validation, so a
 * trailing newline is never "an empty data row".
 */
export function parseChartCsv(text: string): ParsedChartCsv {
  const rows = parseRows(stripBom(text)).filter((row) => !(row.length === 1 && row[0] === ""));
  if (rows.length === 0) {
    throw new CoMotionError("CSV 沒有任何資料列");
  }
  const [header, ...dataRows] = rows;
  if (dataRows.length === 0) {
    throw new CoMotionError("CSV 沒有任何資料列");
  }
  const seriesNames = header.slice(1);
  if (seriesNames.length === 0) {
    throw new CoMotionError("CSV 標頭沒有任何系列欄位");
  }

  const categories: string[] = [];
  const values: number[][] = seriesNames.map(() => []);

  dataRows.forEach((row, rowIndex) => {
    if (row.length !== header.length) {
      throw new CoMotionError(
        `CSV 第 ${rowIndex + 2} 列的欄數（${row.length}）與標頭（${header.length}）不符`,
      );
    }
    categories.push(row[0]);
    for (let col = 1; col < row.length; col++) {
      const raw = row[col];
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        throw new CoMotionError(`CSV 第 ${rowIndex + 2} 列第 ${col + 1} 欄不是合法的數字：${raw}`);
      }
      values[col - 1].push(value);
    }
  });

  return {
    categories,
    series: seriesNames.map((name, index) => ({ name, values: values[index] })),
  };
}
