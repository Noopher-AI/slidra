import { SlidraError } from "./errors.js";

/**
 * The subset of `project.json`'s shape `packages/server` actually reads
 * (`name`, `slides`, `canvas`) — not `packages/core`'s full `ProjectJson`
 * (fonts/templates/transition), which only the Rust binary and its own
 * commands ever need. `slidra open`/`slidra new` already run the
 * real structural validation and formatVersion migration before this
 * server ever sees the id (plan §3.7) — this is a much smaller check that
 * `cat project.json --json`'s output still has the shape this server's own
 * routes index into, not a second copy of core's validator.
 */
export interface ProjectJson {
  formatVersion: number;
  name: string;
  canvas: { width: number; height: number };
  slides: string[];
}

/**
 * The newest `formatVersion` this build understands (mirrors
 * `packages/core`'s `presentation.ts` / `crates/slidra/src/presentation.rs`
 * `FORMAT_VERSION` constant, both currently `4`). A freshly `new`+`open`ed
 * presentation is written at exactly this version, but an older `.slidra`
 * `open` has already validated is legitimately at a lower version forever
 * — `migrateLegacyTransition` only migrates 2→3, and real decks (including
 * several `e2e/fixtures/*` demo decks, found running the e2e suite) sit at
 * 3 or even 1 with no further migration ever applied. Only a version
 * *higher* than this build knows about is a real problem (a newer Slidra
 * wrote it) — reject `>`, never `!==` (an earlier version of this check
 * wrongly required exact equality, which broke on every such fixture).
 */
const CURRENT_FORMAT_VERSION = 4;

/**
 * Minimal structural validation of an already-JSON-parsed `project.json`.
 * A smaller check than `packages/core`'s `validateProjectJson`
 * (`name`/`slides`/`canvas` only — see `ProjectJson`'s own comment) because
 * this server never persists or migrates `project.json` itself; it only
 * ever reads what `slidra` already validated moments earlier. The
 * `formatVersion` upper-bound check mirrors core's own
 * `assertSupportedFormatVersion` exactly (same comparison, same message).
 */
export function validateMinimalProjectJson(value: unknown): ProjectJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SlidraError("project.json 格式錯誤：內容不是物件");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.formatVersion !== "number") {
    throw new SlidraError("project.json 格式錯誤：缺少或型別錯誤的 formatVersion");
  }
  if (record.formatVersion > CURRENT_FORMAT_VERSION) {
    throw new SlidraError(`此簡報由較新版本的 Slidra 建立（格式版本 ${record.formatVersion}），請升級後再開啟`);
  }
  if (typeof record.name !== "string") {
    throw new SlidraError("project.json 格式錯誤：缺少或型別錯誤的 name");
  }
  const canvas = record.canvas;
  if (
    typeof canvas !== "object" ||
    canvas === null ||
    typeof (canvas as Record<string, unknown>).width !== "number" ||
    typeof (canvas as Record<string, unknown>).height !== "number"
  ) {
    throw new SlidraError("project.json 格式錯誤：缺少或型別錯誤的 canvas");
  }
  if (!Array.isArray(record.slides) || !record.slides.every((slide) => typeof slide === "string")) {
    throw new SlidraError("project.json 格式錯誤：slides 不是陣列");
  }

  return record as unknown as ProjectJson;
}
