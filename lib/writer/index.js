// The reference writer for .slidra decks (spec/slidra-format.md, RFC 0001):
// builds a formatVersion 5 SQLite container, edits one in place, and converts
// a legacy ZIP deck. Node-only — it needs node:sqlite (Node >= 22.5).
//
// Every rule the spec puts on writers lives here, so tools and tests get
// them for free: application_id and user_version, journal_mode DELETE,
// explicit directory rows, safe entry paths, project.json serialised with
// two-space indentation and a trailing newline in its original key order,
// unknown fields and tables preserved, and an atomic replace of the file.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APPLICATION_ID, FORMAT_VERSION, isSafeEntryPath, openDeck } from "../viewer/deck.js";
import { checkProject } from "../schema.js";

export class WriterError extends Error {
  constructor(message) {
    super(message);
    this.name = "WriterError";
  }
}

const CONTENT_TABLE =
  "CREATE TABLE content (\n    id   INTEGER PRIMARY KEY,\n    path TEXT    NOT NULL UNIQUE,\n    kind INTEGER NOT NULL,   -- 0 = file, 1 = directory\n    data BLOB                -- NULL for a directory row\n)";
const REQUIRED_DIRECTORIES = ["slides", "assets", "fonts"];

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** A fresh element id: `el-` + 12 base64url characters from 9 random bytes (spec §4.1). */
export function newElementId() {
  return `el-${base64url(randomBytes(9))}`;
}

/** A fresh slide id: `s-` + 12 base64url characters (spec §3). */
export function newSlideId() {
  return `s-${base64url(randomBytes(9))}`;
}

/** project.json as the spec asks writers to serialise it: 2-space indentation, a trailing newline, key order kept. */
export function serializeProject(project) {
  return `${JSON.stringify(project, null, 2)}\n`;
}

const toBytes = (data) => (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength));

function assertPath(entryPath) {
  if (!isSafeEntryPath(entryPath)) throw new WriterError(`unsafe entry path: ${JSON.stringify(entryPath)}`);
}

/** Every directory above `entryPath`, outermost first. */
function parents(entryPath) {
  const segments = entryPath.split("/");
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

/**
 * A deck being built in memory, written out in one go.
 *
 *   const deck = new DeckWriter({ name: "Q3 review", canvas: { width: 1280, height: 720 } });
 *   deck.addSlide(svgSource);
 *   deck.addFile("assets/photo.png", bytes);
 *   deck.write("q3.slidra");
 */
export class DeckWriter {
  /**
   * @param {{ name: string, canvas?: { width: number, height: number }, [key: string]: unknown }} project
   *   project.json fields; `formatVersion` and `slides` are managed by the writer.
   */
  constructor(project) {
    const rest = { ...project };
    delete rest.formatVersion;
    delete rest.slides;
    /** @type {import("../viewer/deck.js").ProjectJson} */
    this.project = { formatVersion: FORMAT_VERSION, name: project.name, canvas: project.canvas ?? { width: 1280, height: 720 }, slides: [], ...rest };
    /** @type {Map<string, Buffer | null>} */
    this.entries = new Map(REQUIRED_DIRECTORIES.map((dir) => [dir, null]));
  }

  /** Adds (or replaces) a file entry, creating its parent directory rows. */
  addFile(entryPath, data) {
    assertPath(entryPath);
    if (entryPath === "project.json") throw new WriterError("project.json is written by the writer; set fields with setProject()");
    for (const dir of parents(entryPath)) {
      if (this.entries.get(dir) instanceof Buffer) throw new WriterError(`${dir} is a file, so it cannot hold ${entryPath}`);
      this.entries.set(dir, null);
    }
    if (this.entries.has(entryPath) && this.entries.get(entryPath) === null) throw new WriterError(`${entryPath} is a directory`);
    this.entries.set(entryPath, toBytes(data));
    return entryPath;
  }

  /** Adds an explicit, possibly empty, directory row (e.g. `assets/data`). */
  addDirectory(entryPath) {
    assertPath(entryPath);
    for (const dir of [...parents(entryPath), entryPath]) {
      if (this.entries.get(dir) instanceof Buffer) throw new WriterError(`${dir} is a file`);
      this.entries.set(dir, null);
    }
  }

  /**
   * Appends a slide. Its path defaults to the next `slides/NNN.svg`.
   * @returns {string} the slide's path
   */
  /** @param {string | Uint8Array} source @param {{ path?: string }} [options] */
  addSlide(source, { path: slidePath } = {}) {
    const entryPath = slidePath ?? this.nextSlidePath();
    if (!entryPath.startsWith("slides/")) throw new WriterError(`slides live under slides/, not ${entryPath}`);
    this.addFile(entryPath, source);
    this.project.slides.push(entryPath);
    return entryPath;
  }

  nextSlidePath() {
    for (let n = this.project.slides.length + 1; ; n++) {
      const candidate = `slides/${String(n).padStart(3, "0")}.svg`;
      if (!this.entries.has(candidate)) return candidate;
    }
  }

  /** Embeds a font and its licence and registers it in project.json (spec §8). */
  addFont({ file, family, license, licenseFile, source }, fontBytes, licenseBytes) {
    this.addFile(file, fontBytes);
    if (licenseBytes !== undefined) this.addFile(licenseFile, licenseBytes);
    const fonts = Array.isArray(this.project.fonts) ? this.project.fonts : [];
    this.project.fonts = [...fonts.filter((font) => font.family !== family), { file, family, license, licenseFile, source }];
  }

  /** Merges fields into project.json, keeping the existing key order. */
  setProject(fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (key === "formatVersion" || key === "slides") throw new WriterError(`${key} is managed by the writer`);
      this.project[key] = value;
    }
  }

  /** Checks the deck against the spec's writer rules; throws a WriterError listing every problem. */
  validate() {
    const problems = checkProject(this.project).map((issue) => `project.json${issue.path === "/" ? "" : issue.path}: ${issue.message}`);
    for (const slide of this.project.slides) if (!(this.entries.get(slide) instanceof Buffer)) problems.push(`slide ${slide} has no file`);
    for (const font of this.project.fonts ?? []) {
      if (!(this.entries.get(font.file) instanceof Buffer)) problems.push(`font ${font.file} has no file`);
      if (font.licenseFile && !(this.entries.get(font.licenseFile) instanceof Buffer)) problems.push(`font licence ${font.licenseFile} has no file`);
    }
    if (problems.length > 0) throw new WriterError(`the deck breaks the format's writer rules:\n- ${problems.join("\n- ")}`);
  }

  /**
   * Writes the deck to `file`, atomically: a sibling temporary file, then a
   * rename. `validate: false` skips the writer-rule check — only for tests
   * that need a deliberately broken deck.
   */
  write(file, { validate = true } = {}) {
    if (validate) this.validate();
    atomically(file, (temp) => {
      const db = new DatabaseSync(temp);
      try {
        initialise(db);
        const insert = db.prepare("INSERT INTO content (path, kind, data) VALUES (?, ?, ?)");
        db.exec("BEGIN");
        for (const [entryPath, data] of [...this.entries].sort(([a], [b]) => a.localeCompare(b))) insert.run(entryPath, data === null ? 1 : 0, data);
        insert.run("project.json", 0, Buffer.from(serializeProject(this.project), "utf8"));
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    });
  }
}

function initialise(db) {
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
  db.exec(CONTENT_TABLE);
}

/** Runs `build(tempPath)` and moves the result over `file`; the temp file never survives a failure. */
function atomically(file, build) {
  const temp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    build(temp);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    rmSync(`${temp}-journal`, { force: true });
    throw error;
  }
}

/**
 * Edits a formatVersion 5 deck in place, keeping every table and row it does
 * not touch (spec §1.1: writers preserve what they do not understand). The
 * edit runs on a copy that replaces the original only if `edit` succeeds.
 *
 *   await editDeck("talk.slidra", (deck) => {
 *     deck.writeFile("assets/logo.png", bytes);
 *     deck.updateProject((project) => ({ ...project, modified: new Date().toISOString() }));
 *   });
 *
 * @param {string} file
 * @param {(deck: DeckEditor) => void | Promise<void>} edit
 */
export async function editDeck(file, edit) {
  const bytes = new Uint8Array(readFileSync(file));
  const opened = await openDeck(bytes, { fileName: path.basename(file) });
  if (opened.container !== "sqlite") throw new WriterError(`${file} is a legacy ZIP deck; convert it with convertLegacyDeck() first`);
  const temp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  copyFileSync(file, temp);
  let db;
  try {
    db = new DatabaseSync(temp);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("BEGIN");
    const editor = new DeckEditor(db, opened.project);
    await edit(editor);
    editor.flush();
    db.exec("COMMIT");
    db.close();
    db = null;
    renameSync(temp, file);
  } catch (error) {
    if (db) db.close();
    rmSync(temp, { force: true });
    rmSync(`${temp}-journal`, { force: true });
    throw error;
  }
}

/** The handle `editDeck` passes to its callback. */
export class DeckEditor {
  constructor(db, project) {
    this.db = db;
    this.project = project;
    this.projectChanged = false;
  }

  readFile(entryPath) {
    const row = this.db.prepare("SELECT kind, data FROM content WHERE path = ?").get(entryPath);
    return row && row.kind === 0 ? new Uint8Array(/** @type {Uint8Array} */ (row.data)) : null;
  }

  writeFile(entryPath, data) {
    assertPath(entryPath);
    if (entryPath === "project.json") throw new WriterError("change project.json with updateProject()");
    for (const dir of parents(entryPath)) this.db.prepare("INSERT INTO content (path, kind, data) VALUES (?, 1, NULL) ON CONFLICT(path) DO NOTHING").run(dir);
    this.db.prepare("INSERT INTO content (path, kind, data) VALUES (?, 0, ?) ON CONFLICT(path) DO UPDATE SET kind = 0, data = excluded.data").run(entryPath, toBytes(data));
  }

  deleteFile(entryPath) {
    if (this.project.slides.includes(entryPath)) throw new WriterError(`${entryPath} is listed in slides; remove it from project.json first`);
    this.db.prepare("DELETE FROM content WHERE path = ? AND kind = 0").run(entryPath);
  }

  /** Replaces project.json with `change(project)`; key order is whatever the returned object has. */
  updateProject(change) {
    this.project = change(structuredClone(this.project));
    this.projectChanged = true;
  }

  flush() {
    if (!this.projectChanged) return;
    const problems = checkProject(this.project);
    if (problems.length > 0) throw new WriterError(`project.json would break the schema: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);
    for (const slide of this.project.slides) {
      if (!this.readFile(slide)) throw new WriterError(`project.json lists ${slide}, but the deck has no such file`);
    }
    this.db.prepare("UPDATE content SET data = ? WHERE path = 'project.json'").run(Buffer.from(serializeProject(this.project), "utf8"));
  }
}

/**
 * Converts a legacy ZIP deck (formatVersion 1–4) to the SQLite container at
 * formatVersion 5 — the one conversion the spec sanctions (§1.2). Writes
 * `outFile` atomically; `outFile` may equal `zipFile`.
 */
export async function convertLegacyDeck(zipFile, outFile = zipFile) {
  const deck = await openDeck(new Uint8Array(readFileSync(zipFile)), { fileName: path.basename(zipFile) });
  if (deck.container !== "zip") throw new WriterError(`${zipFile} is already a SQLite deck`);
  const project = { ...deck.project, formatVersion: FORMAT_VERSION };
  atomically(outFile, (temp) => {
    const db = new DatabaseSync(temp);
    try {
      initialise(db);
      const insert = db.prepare("INSERT INTO content (path, kind, data) VALUES (?, ?, ?)");
      db.exec("BEGIN");
      const paths = new Set(REQUIRED_DIRECTORIES);
      for (const entryPath of deck.list()) paths.add(entryPath);
      for (const entryPath of [...paths].sort()) {
        if (entryPath === "project.json") continue;
        const data = deck.entries.get(entryPath);
        insert.run(entryPath, data instanceof Uint8Array ? 0 : 1, data instanceof Uint8Array ? toBytes(data) : null);
      }
      insert.run("project.json", 0, Buffer.from(serializeProject(project), "utf8"));
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  });
  if (!existsSync(outFile)) throw new WriterError(`conversion did not produce ${outFile}`);
}
