// A minimal, read-only SQLite 3 file reader — just enough of the on-disk
// format (https://www.sqlite.org/fileformat2.html) to walk a rowid table's
// b-tree and decode its records, including overflow pages. It exists so a
// `.slidra` deck (a SQLite database, see spec/rfcs/0001) can be opened
// entirely in the browser with no WebAssembly and no dependency.
//
// Not supported, deliberately: WAL content that has not been checkpointed
// (a `.slidra` deck uses journal_mode=DELETE, so a closed deck never has
// any), WITHOUT ROWID tables, and index b-trees (a full table scan is all a
// viewer needs).

const MAGIC = "SQLite format 3\u0000";

export class SqliteFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteFormatError";
  }
}

/** True when `bytes` starts with the SQLite 3 header string. */
export function isSqlite(bytes) {
  if (bytes.length < 16) return false;
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export class SqliteReader {
  /** @param {Uint8Array} bytes the whole database file */
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SqliteReader expects a Uint8Array");
    if (bytes.length < 100 || !isSqlite(bytes)) throw new SqliteFormatError("not a SQLite 3 database");
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const rawPageSize = this.view.getUint16(16);
    this.pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) {
      throw new SqliteFormatError(`invalid page size ${rawPageSize}`);
    }
    this.usableSize = this.pageSize - bytes[20];
    this.pageCount = Math.floor(bytes.length / this.pageSize);

    const encoding = this.view.getUint32(56);
    if (encoding !== 0 && encoding !== 1) {
      // A `.slidra` deck is always UTF-8; UTF-16 databases are out of scope.
      throw new SqliteFormatError(`unsupported text encoding ${encoding} (only UTF-8 is supported)`);
    }
    this.userVersion = this.view.getInt32(60);
    this.applicationId = this.view.getInt32(68);
    this.writeVersion = bytes[18];
    this.readVersion = bytes[19];
    this.decoder = new TextDecoder("utf-8");
  }

  /** `sqlite_schema` rows: `{ type, name, tbl_name, rootpage, sql }`. */
  schema() {
    const rows = [];
    for (const { values } of this.#scanTable(1)) {
      rows.push({ type: values[0], name: values[1], tbl_name: values[2], rootpage: values[3], sql: values[4] });
    }
    return rows;
  }

  /**
   * Every row of the rowid table `name`, as objects keyed by column name,
   * in rowid order. An `INTEGER PRIMARY KEY` column reads back as the rowid
   * (SQLite stores it as NULL in the record itself).
   */
  readTable(name) {
    const entry = this.schema().find((row) => row.type === "table" && row.name === name);
    if (!entry) throw new SqliteFormatError(`no table named "${name}"`);
    const columns = parseColumns(entry.sql);
    if (!columns) throw new SqliteFormatError(`cannot parse the definition of table "${name}"`);
    const rowidAlias = columns.findIndex((column) => column.rowidAlias);
    const rows = [];
    for (const { rowid, values } of this.#scanTable(entry.rootpage)) {
      const row = {};
      columns.forEach((column, i) => {
        row[column.name] = i === rowidAlias ? rowid : i < values.length ? values[i] : null;
      });
      rows.push(row);
    }
    return rows;
  }

  #page(number) {
    if (!Number.isInteger(number) || number < 1 || number > this.pageCount) {
      throw new SqliteFormatError(`page ${number} is out of range (1..${this.pageCount})`);
    }
    const start = (number - 1) * this.pageSize;
    return start;
  }

  /** Iterative in-order walk of a table b-tree rooted at `rootPage`. */
  *#scanTable(rootPage) {
    const stack = [rootPage];
    const visited = new Set();
    while (stack.length > 0) {
      const number = stack.pop();
      if (visited.has(number)) throw new SqliteFormatError(`b-tree cycle at page ${number}`);
      visited.add(number);

      const pageStart = this.#page(number);
      const headerStart = pageStart + (number === 1 ? 100 : 0);
      const type = this.bytes[headerStart];
      const cellCount = this.view.getUint16(headerStart + 3);

      if (type === 0x05) {
        // Interior table page: children left to right, then the right-most
        // pointer. Pushed in reverse so the stack pops them in order.
        const children = [];
        const pointers = headerStart + 12;
        for (let i = 0; i < cellCount; i++) {
          const cell = pageStart + this.view.getUint16(pointers + i * 2);
          children.push(this.view.getUint32(cell));
        }
        children.push(this.view.getUint32(headerStart + 8));
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        continue;
      }
      if (type !== 0x0d) throw new SqliteFormatError(`page ${number} is not a table b-tree page (type ${type})`);

      const pointers = headerStart + 8;
      for (let i = 0; i < cellCount; i++) {
        let offset = pageStart + this.view.getUint16(pointers + i * 2);
        const [payloadSize, n1] = readVarint(this.bytes, offset);
        offset += n1;
        const [rowid, n2] = readVarint(this.bytes, offset);
        offset += n2;
        const payload = this.#payload(offset, payloadSize);
        yield { rowid, values: this.#decodeRecord(payload) };
      }
    }
  }

  /** Assembles a cell's full payload, following the overflow chain when it spilled. */
  #payload(offset, size) {
    const U = this.usableSize;
    const X = U - 35;
    if (size <= X) return this.bytes.subarray(offset, offset + size);

    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (U - 4));
    const local = K <= X ? K : M;

    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(offset, offset + local), 0);
    let written = local;
    let next = this.view.getUint32(offset + local);
    const seen = new Set();
    while (written < size) {
      if (next === 0) throw new SqliteFormatError("overflow chain ended before the payload was complete");
      if (seen.has(next)) throw new SqliteFormatError(`overflow chain cycle at page ${next}`);
      seen.add(next);
      const start = this.#page(next);
      const chunk = Math.min(U - 4, size - written);
      out.set(this.bytes.subarray(start + 4, start + 4 + chunk), written);
      written += chunk;
      next = this.view.getUint32(start);
    }
    return out;
  }

  #decodeRecord(payload) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const [headerSize, n] = readVarint(payload, 0);
    const types = [];
    let cursor = n;
    while (cursor < headerSize) {
      const [type, m] = readVarint(payload, cursor);
      types.push(type);
      cursor += m;
    }
    let body = headerSize;
    const values = [];
    for (const type of types) {
      switch (type) {
        case 0:
          values.push(null);
          break;
        case 1:
          values.push(view.getInt8(body));
          body += 1;
          break;
        case 2:
          values.push(view.getInt16(body));
          body += 2;
          break;
        case 3:
          values.push((view.getInt8(body) << 16) | view.getUint16(body + 1));
          body += 3;
          break;
        case 4:
          values.push(view.getInt32(body));
          body += 4;
          break;
        case 5:
          values.push(view.getInt16(body) * 2 ** 32 + view.getUint32(body + 2));
          body += 6;
          break;
        case 6:
          values.push(Number(view.getBigInt64(body)));
          body += 8;
          break;
        case 7:
          values.push(view.getFloat64(body));
          body += 8;
          break;
        case 8:
          values.push(0);
          break;
        case 9:
          values.push(1);
          break;
        case 10:
        case 11:
          throw new SqliteFormatError(`reserved serial type ${type}`);
        default: {
          const length = type % 2 === 0 ? (type - 12) / 2 : (type - 13) / 2;
          const slice = payload.subarray(body, body + length);
          values.push(type % 2 === 0 ? slice : this.decoder.decode(slice));
          body += length;
        }
      }
    }
    return values;
  }
}

/** SQLite's big-endian varint: 7 bits per byte for up to 8 bytes, all 8 bits of a 9th. Returns `[value, bytesRead]`. */
export function readVarint(bytes, offset) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[offset + i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  value = value * 256 + bytes[offset + 8];
  return [value, 9];
}

/**
 * Column names from a `CREATE TABLE` statement, in declaration order, with
 * the (single) `INTEGER PRIMARY KEY` column flagged as the rowid alias.
 * Handles the simple, unquoted-or-quoted column lists SQLite writes back
 * verbatim into `sqlite_schema.sql`; table constraints are skipped.
 */
export function parseColumns(sql) {
  if (typeof sql !== "string") return null;
  // SQLite keeps the statement verbatim, comments included — and a comment
  // may well contain a comma. (Quoted identifiers never contain "--" here.)
  sql = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open === -1 || close <= open) return null;
  const body = sql.slice(open + 1, close);

  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);

  const columns = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(part)) continue;
    const match = /^(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([^\s]+))\s*(.*)$/s.exec(part);
    if (!match) return null;
    const name = match[1] !== undefined ? match[1].replace(/""/g, '"') : (match[2] ?? match[3] ?? match[4]);
    const rest = match[5] ?? "";
    const rowidAlias = /^integer\b/i.test(rest) && /\bprimary\s+key\b/i.test(rest) && !/\bdesc\b/i.test(rest);
    columns.push({ name, rowidAlias });
  }
  return columns;
}
