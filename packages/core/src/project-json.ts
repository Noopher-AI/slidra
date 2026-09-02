import { CoMotionError } from "./errors.js";
import { FORMAT_VERSION } from "./presentation.js";

/**
 * The structural shape `project.json` is guaranteed to hold (ADR-0003):
 * everything an SVG cannot express — format version, name, canvas size, and
 * the explicit slide order.
 */
export interface ProjectJson {
  formatVersion: number;
  name: string;
  canvas: { width: number; height: number };
  slides: string[];
  /**
   * Fonts embedded in the container (ticket #71, contract in ADR-0016).
   * Optional — a presentation with no `fonts` field (every pre-#71
   * `.comot`) is still structurally valid; `formatVersion` does not change
   * for this addition.
   */
  fonts?: FontEntry[];
  /**
   * The presentation's templates (T3/[E4.T7], ADR-0013), living under
   * `templates/`. Optional — a pre-T3 `.comot` has no `templates` field. A
   * template is edited with the same element commands a slide is
   * (workspace.ts's `assertSlidePathListed` accepts either list), but never
   * appears in `slides`.
   *
   * A pre-[E4.T7] `.comot` stores each entry as a bare virtual-path string
   * (no name). `readTemplateEntries` is the one place that normalizes both
   * shapes into `TemplateEntry[]` — nothing else should read this field
   * directly. `writeProject` (slide-ops.ts) upgrades a file's `templates`
   * to the object shape the next time it writes `project.json` at all;
   * this field's declared type stays a union so an untouched pre-upgrade
   * file still type-checks.
   */
  templates?: (string | TemplateEntry)[];
  /**
   * The presentation's slide transition (T3), `"none" | "fade"` — enforced
   * at write time by `slide-ops.ts`'s `setTransition`, not here (a later
   * build may add a transition name this build has never heard of, and
   * `validateProjectJson` only checks shape, not the enum). Optional and
   * missing on every pre-T3 `.comot`; a reader treats a missing value as
   * `"none"`. This ticket only stores the value — nothing plays it back.
   */
  transition?: string;
}

/** One entry of `project.json`'s `templates` ([E4.T7]), as normalized by `readTemplateEntries`. */
export interface TemplateEntry {
  /** Virtual path inside the container, e.g. "templates/001.svg". */
  file: string;
  /** User-visible name. May be any non-empty string; two templates may share one (A6). */
  name: string;
}

/** One font embedded in the container, referenced by `project.json`'s `fonts`. */
export interface FontEntry {
  /** Virtual path to the font file inside the container, e.g. "fonts/NotoSansTC-Presentation.ttf". */
  file: string;
  /** The SVG `font-family` value slides reference. */
  family: string;
  /** Human-readable license name, e.g. "SIL Open Font License 1.1". */
  license: string;
  /** Virtual path to the full license text inside the container. */
  licenseFile: string;
  /** Where the font was obtained from. */
  source: string;
}

/**
 * Structural validation of an already-JSON-parsed `project.json`. The
 * single source of truth shared by `open` (container.ts's `unpackContainer`)
 * and `serve` (server's `loadProject`) — previously each kept its own copy,
 * which let a container like `{"formatVersion":1}` pass `open`'s
 * formatVersion-only check and then explode inside `serve` as a native
 * TypeError on `slides` being undefined (ticket #12). Checking it once,
 * here, means both callers fail on the same field with the same wording.
 *
 * An empty `slides` array is structurally valid — "no slides yet" is a
 * shape a presentation can legally have. Whether an empty presentation may
 * actually be *served* is a separate, business-rule concern `serve.ts`
 * still owns on its own (`簡報沒有投影片`); this validator only checks
 * shape, not "is there anything to show".
 *
 * Unknown extra fields are accepted, not rejected: a later `formatVersion`
 * may introduce fields this build has never heard of, and rejecting an
 * otherwise-valid file over an unrecognised field would make forward
 * compatibility impossible (ADR-0003's whole reason `formatVersion` exists).
 *
 * Never includes a filesystem path in its message (ADR-0004) — a caller
 * that wants to name the `.comot` file the user supplied appends that
 * itself, since only the caller knows whether it has one to contextualise
 * the error with.
 */
export function validateProjectJson(value: unknown): ProjectJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoMotionError("project.json 格式錯誤：內容不是物件");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.formatVersion !== "number") {
    throw new CoMotionError("project.json 格式錯誤：缺少或型別錯誤的 formatVersion");
  }
  if (typeof record.name !== "string") {
    throw new CoMotionError("project.json 格式錯誤：缺少或型別錯誤的 name");
  }
  const canvas = record.canvas;
  if (
    typeof canvas !== "object" ||
    canvas === null ||
    typeof (canvas as Record<string, unknown>).width !== "number" ||
    typeof (canvas as Record<string, unknown>).height !== "number"
  ) {
    throw new CoMotionError("project.json 格式錯誤：缺少或型別錯誤的 canvas");
  }
  if (!Array.isArray(record.slides)) {
    throw new CoMotionError("project.json 格式錯誤：slides 不是陣列");
  }
  if (!record.slides.every((slide) => typeof slide === "string")) {
    throw new CoMotionError("project.json 格式錯誤：slides 內含無效項目");
  }
  if ("fonts" in record) {
    validateFonts(record.fonts);
  }
  if ("templates" in record) {
    validateTemplates(record.templates);
  }
  if ("transition" in record && typeof record.transition !== "string") {
    throw new CoMotionError("project.json 格式錯誤：transition 不是字串");
  }

  // Extra unknown fields stay on the object (see the forward-compatibility
  // note above) — the cast only asserts the fields this build cares about.
  return record as unknown as ProjectJson;
}

const FONT_ENTRY_STRING_FIELDS = ["file", "family", "license", "licenseFile", "source"] as const;

/** Structural + referential validation of the optional `fonts` field. */
function validateFonts(value: unknown): asserts value is FontEntry[] {
  if (!Array.isArray(value)) {
    throw new CoMotionError("project.json 格式錯誤：fonts 不是陣列");
  }
  const seenFamilies = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new CoMotionError("project.json 格式錯誤：fonts 內含無效項目");
    }
    const record = entry as Record<string, unknown>;
    for (const field of FONT_ENTRY_STRING_FIELDS) {
      if (typeof record[field] !== "string") {
        throw new CoMotionError(`project.json 格式錯誤：fonts 內的項目缺少或型別錯誤的 ${field}`);
      }
    }
    for (const pathField of ["file", "licenseFile"] as const) {
      const path = record[pathField] as string;
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new CoMotionError("project.json 格式錯誤：fonts 內含不合法的路徑");
      }
    }
    const family = record.family as string;
    if (seenFamilies.has(family)) {
      throw new CoMotionError("project.json 格式錯誤：fonts 內有重複的 family");
    }
    seenFamilies.add(family);
  }
}

/**
 * Structural validation of the optional `templates` field. Accepts a
 * mixture of pre-[E4.T7] bare-string entries and post-upgrade `TemplateEntry`
 * objects in the same array — that mixture is the natural mid-upgrade state
 * of a file only some of whose writes have gone through `writeProject`'s
 * normalization (see `ProjectJson.templates`'s doc comment), not an error.
 */
function validateTemplates(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new CoMotionError("project.json 格式錯誤：templates 不是陣列");
  }
  for (const entry of value) {
    if (typeof entry === "string") continue;
    if (typeof entry !== "object" || entry === null) {
      throw new CoMotionError("project.json 格式錯誤：templates 內含無效項目");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.file !== "string") {
      throw new CoMotionError("project.json 格式錯誤：templates 內的項目缺少或型別錯誤的 file");
    }
    if (typeof record.name !== "string") {
      throw new CoMotionError("project.json 格式錯誤：templates 內的項目缺少或型別錯誤的 name");
    }
    if (record.file.startsWith("/") || record.file.split("/").includes("..")) {
      throw new CoMotionError("project.json 格式錯誤：templates 內含不合法的路徑");
    }
  }
}

/**
 * The one entry point through which `templates` is ever read — normalizes
 * a pre-[E4.T7] bare-string entry into `{ file, name }` with `name` falling
 * back to the file's basename minus extension (A11: an old presentation
 * shows its templates' filenames, never a blank name). Callers must never
 * read `project.templates` directly (workspace.ts's `assertSlidePathListed`
 * and slide-ops.ts's `addSlide`/`duplicateSlide` all route through this).
 */
export function readTemplateEntries(project: ProjectJson): TemplateEntry[] {
  const templates = project.templates ?? [];
  return templates.map((entry) => {
    if (typeof entry === "string") {
      const base = entry.split("/").pop() ?? entry;
      const name = base.replace(/\.svg$/, "");
      return { file: entry, name };
    }
    return entry;
  });
}

/**
 * Rejects a `project.json` written by a newer CoMotion than this build
 * understands. Deliberately not folded into `validateProjectJson` — that
 * function's whole reason for only checking shape (never an upper bound)
 * is forward compatibility with fields it has never heard of; a future
 * `formatVersion` is exactly the case that comment protects. Called only at
 * the two places a presentation is loaded from disk into memory:
 * `unpackContainer` (open) and the server's `loadProject` — not on every
 * `slide-ops.ts` read, since those all operate on a work directory `open`
 * already validated.
 */
export function assertSupportedFormatVersion(project: ProjectJson): void {
  if (project.formatVersion > FORMAT_VERSION) {
    throw new CoMotionError(
      `此簡報由較新版本的 CoMotion 建立（格式版本 ${project.formatVersion}），請升級後再開啟`,
    );
  }
}
