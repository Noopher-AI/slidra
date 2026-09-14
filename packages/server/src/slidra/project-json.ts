// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
 * `crates/slidra/src/presentation.rs`'s `FORMAT_VERSION` constant, both
 * currently `5` — the SQLite container format,
 * `spec/rfcs/0001-sqlite-container-format.md`). `slidra open` migrates a
 * deck to this exact version unconditionally now, so every presentation id
 * this server ever sees is already at `5` by the time it gets here — this
 * check exists for the same reason it always did: only a version *higher*
 * than this build knows about is a real problem (a newer Slidra wrote it)
 * — reject `>`, never `!==` (an earlier version of this check wrongly
 * required exact equality, which broke on every legacy-version fixture
 * before migration was mandatory).
 */
const CURRENT_FORMAT_VERSION = 5;

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
    throw new SlidraError("project.json format error: content is not an object");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.formatVersion !== "number") {
    throw new SlidraError("Malformed project.json: formatVersion is missing or has the wrong type");
  }
  if (record.formatVersion > CURRENT_FORMAT_VERSION) {
    throw new SlidraError(`This presentation was created by a newer version of Slidra (format version ${record.formatVersion}), please upgrade before opening it`);
  }
  if (typeof record.name !== "string") {
    throw new SlidraError("project.json format error: missing or wrong type for name");
  }
  const canvas = record.canvas;
  if (
    typeof canvas !== "object" ||
    canvas === null ||
    typeof (canvas as Record<string, unknown>).width !== "number" ||
    typeof (canvas as Record<string, unknown>).height !== "number"
  ) {
    throw new SlidraError("project.json format error: missing or wrong type for canvas");
  }
  if (!Array.isArray(record.slides) || !record.slides.every((slide) => typeof slide === "string")) {
    throw new SlidraError("project.json format error: slides is not an array");
  }

  return record as unknown as ProjectJson;
}
