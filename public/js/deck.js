// Opens a `.slidra` file (spec/slidra-format.md) into an in-memory,
// read-only Deck: its validated `project.json` plus every entry, by virtual
// path. Knows both containers — the current SQLite one (formatVersion 5)
// and the legacy ZIP one (formatVersion 1-4) — and sniffs the header bytes,
// never the file extension.

import { SqliteReader, isSqlite } from "./sqlite-reader.js";
import { isZip, readZip } from "./zip-reader.js";

export const FORMAT_VERSION = 5;
/** ASCII "Sldr", the container's `PRAGMA application_id` (RFC 0001 §1). */
export const APPLICATION_ID = 0x536c6472;
export const NAMESPACE = "https://slidra.app/ns/2026";

export class DeckError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeckError";
  }
}

const MIME_TYPES = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".opus": "audio/opus",
  ".oga": "audio/ogg",
  ".aac": "audio/aac",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export function mimeTypeFor(path) {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? null : MIME_TYPES[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/** Spec §1.3: no absolute path, no `..` segment, no backslash, no empty segment. */
export function isSafeEntryPath(path) {
  if (typeof path !== "string" || path === "") return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\u0000")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export class Deck {
  /**
   * @param {object} project validated project.json
   * @param {Map<string, Uint8Array|null>} entries virtual path -> bytes (null = directory)
   * @param {{ container: "sqlite"|"zip", fileName?: string }} info
   */
  constructor(project, entries, info) {
    this.project = project;
    this.entries = entries;
    this.container = info.container;
    this.fileName = info.fileName ?? null;
    this.textDecoder = new TextDecoder("utf-8");
    this.dataUrls = new Map();
  }

  get name() {
    return this.project.name;
  }

  get canvas() {
    return this.project.canvas;
  }

  get slides() {
    return this.project.slides;
  }

  /** Registered fonts; an older deck with no `fonts` field but the default face on disk still gets it. */
  get fonts() {
    if (Array.isArray(this.project.fonts) && this.project.fonts.length > 0) {
      return this.project.fonts.filter((font) => font && typeof font.file === "string" && typeof font.family === "string");
    }
    const fallback = "fonts/NotoSansTC-Presentation.ttf";
    return this.hasFile(fallback) ? [{ file: fallback, family: "Noto Sans TC" }] : [];
  }

  hasFile(path) {
    return this.entries.get(path) instanceof Uint8Array;
  }

  readBytes(path) {
    const bytes = this.entries.get(path);
    if (!(bytes instanceof Uint8Array)) throw new DeckError(`missing file in deck: ${path}`);
    return bytes;
  }

  readText(path) {
    return this.textDecoder.decode(this.readBytes(path));
  }

  /** A `data:` URL for one entry, memoised: the sandboxed slide frame is an opaque origin, where neither this origin's URLs nor its `blob:` URLs are reliably loadable. */
  dataUrl(path) {
    let url = this.dataUrls.get(path);
    if (url === undefined) {
      url = `data:${mimeTypeFor(path)};base64,${base64(this.readBytes(path))}`;
      this.dataUrls.set(path, url);
    }
    return url;
  }

  /** Every virtual path, files and directories, sorted. */
  list() {
    return [...this.entries.keys()].sort();
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {{ fileName?: string }} [options]
 * @returns {Promise<Deck>}
 */
export async function openDeck(bytes, options = {}) {
  if (isSqlite(bytes)) return openSqliteDeck(bytes, options);
  if (isZip(bytes)) return openZipDeck(bytes, options);
  throw new DeckError("This is not a .slidra file: the header is neither SQLite (formatVersion 5) nor ZIP (formatVersion 1-4).");
}

function openSqliteDeck(bytes, options) {
  let db;
  try {
    db = new SqliteReader(bytes);
  } catch (error) {
    throw new DeckError(`This file starts like a SQLite deck but cannot be read (${error.message}); it may be truncated or damaged.`);
  }
  if (db.applicationId !== 0 && db.applicationId !== APPLICATION_ID) {
    throw new DeckError(`This SQLite file is not a .slidra deck (application_id is 0x${(db.applicationId >>> 0).toString(16)}).`);
  }
  if (db.writeVersion === 2 || db.readVersion === 2) {
    // A WAL-mode database may keep committed pages in a -wal sibling this
    // single file does not carry. RFC 0001 mandates journal_mode=DELETE.
    console.warn("[slidra] deck is in WAL mode; content not yet checkpointed will be missing");
  }
  let rows;
  try {
    rows = db.readTable("content");
  } catch (error) {
    throw new DeckError(`This SQLite file has no readable "content" table, so it is not a .slidra deck (${error.message}).`);
  }

  const entries = new Map();
  for (const row of rows) {
    if (!isSafeEntryPath(row.path)) throw new DeckError(`unsafe entry path in deck: ${JSON.stringify(row.path)}`);
    if (row.kind === 1) entries.set(row.path, null);
    else if (row.kind === 0) entries.set(row.path, row.data instanceof Uint8Array ? row.data : new TextEncoder().encode(String(row.data ?? "")));
    else throw new DeckError(`entry ${row.path} has unknown kind ${row.kind}`);
  }
  const project = readProject(entries, "sqlite");
  if (db.userVersion !== 0 && db.userVersion !== project.formatVersion) {
    throw new DeckError(`user_version (${db.userVersion}) and project.json formatVersion (${project.formatVersion}) disagree; the deck is corrupted.`);
  }
  return new Deck(project, entries, { container: "sqlite", fileName: options.fileName });
}

async function openZipDeck(bytes, options) {
  const raw = await readZip(bytes);
  const entries = new Map();
  for (const [path, data] of raw) {
    if (!isSafeEntryPath(path)) throw new DeckError(`unsafe entry path in deck: ${JSON.stringify(path)}`);
    entries.set(path, data);
    // ZIP archives often list files without their parent directories.
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (!entries.has(dir)) entries.set(dir, null);
    }
  }
  const project = readProject(entries, "zip");
  for (const [path, data] of entries) {
    if (data && path.endsWith(".svg")) {
      const text = new TextDecoder().decode(data);
      if (text.includes("xmlns:comot") || text.includes("co-motion.dev/ns")) {
        throw new DeckError("This is a legacy CoMotion file, which is not a .slidra deck (spec §2.7).");
      }
    }
  }
  return new Deck(project, entries, { container: "zip", fileName: options.fileName });
}

/** Parses and validates `project.json` (spec §2). Unknown fields are kept. */
export function readProject(entries, container) {
  const bytes = entries.get("project.json");
  if (!(bytes instanceof Uint8Array)) throw new DeckError("The deck has no project.json.");
  let project;
  try {
    project = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new DeckError(`project.json is not valid JSON: ${error.message}`);
  }
  if (project === null || typeof project !== "object" || Array.isArray(project)) {
    throw new DeckError("project.json must be a JSON object.");
  }

  const version = project.formatVersion;
  if (!Number.isInteger(version)) throw new DeckError("project.json is missing formatVersion.");
  if (container === "sqlite" && version !== FORMAT_VERSION) {
    throw new DeckError(`A SQLite deck must be formatVersion ${FORMAT_VERSION}, but this one says ${version}.`);
  }
  if (container === "zip" && (version < 1 || version > 4)) {
    throw new DeckError(`A ZIP deck must be formatVersion 1-4, but this one says ${version}.`);
  }
  if (typeof project.name !== "string") throw new DeckError("project.json name must be a string.");
  const canvas = project.canvas;
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0) || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height)) {
    throw new DeckError("project.json canvas must have positive width and height.");
  }
  if (!Array.isArray(project.slides)) throw new DeckError("project.json slides must be an array.");
  for (const slide of project.slides) {
    if (!isSafeEntryPath(slide)) throw new DeckError(`project.json lists an invalid slide path: ${JSON.stringify(slide)}`);
    if (!(entries.get(slide) instanceof Uint8Array)) throw new DeckError(`project.json lists ${slide}, but the deck has no such file.`);
  }
  if (project.fonts !== undefined) {
    if (!Array.isArray(project.fonts)) throw new DeckError("project.json fonts must be an array.");
    for (const font of project.fonts) {
      if (!font || !isSafeEntryPath(font.file)) throw new DeckError(`project.json lists an invalid font file: ${JSON.stringify(font && font.file)}`);
    }
  }
  return project;
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
