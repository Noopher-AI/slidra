import { CoMotionError } from "./errors.js";

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
   * Fonts embedded in the container (ticket #71). Optional — a presentation
   * with no `fonts` field (every pre-#71 `.comot`) is still structurally
   * valid; `formatVersion` does not change for this addition.
   */
  fonts?: FontEntry[];
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
    const file = record.file as string;
    if (file.startsWith("/") || file.split("/").includes("..")) {
      throw new CoMotionError("project.json 格式錯誤：fonts 內含不合法的路徑");
    }
    const family = record.family as string;
    if (seenFamilies.has(family)) {
      throw new CoMotionError("project.json 格式錯誤：fonts 內有重複的 family");
    }
    seenFamilies.add(family);
  }
}
