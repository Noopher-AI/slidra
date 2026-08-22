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

  // Extra unknown fields stay on the object (see the forward-compatibility
  // note above) — the cast only asserts the fields this build cares about.
  return record as unknown as ProjectJson;
}
