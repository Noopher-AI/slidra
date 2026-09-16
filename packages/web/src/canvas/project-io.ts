// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { PageTransitionEffect } from "../effects.js";

interface ProjectJson {
  name: string;
  slides: string[];
  /**
   * Fonts embedded in the container (ticket #71's `FontEntry`, minimal
   * subset). Only present in the wire payload when the presentation
   * declares any — used by the textbox-width handle's live preview to
   * fetch and parse the exact font bytes `wrapText` needs (§4.4).
   */
  fonts?: { file: string; family: string }[];
  /**
   * The deck's templates (spec §2.4). A legacy entry is a bare string; a
   * current one is `{file, name}` — both may appear in the same array.
   * Only present when the deck declares at least one. `setPageSource`'s
   * `"templates"` branch is the only reader.
   */
  templates?: (string | { file: string; name: string })[];
}

/**
 * Normalizes `project.json`'s `templates` field (bare strings and
 * `{file, name}` objects, possibly mixed — spec §2.4) into the plain path
 * list `reload()` treats as the page list while master mode is active. An
 * entry that is neither a string nor an object with a string `file` is a
 * project.json format error: counted here so the caller can report it
 * once, never silently dropped and never given a fabricated path.
 */
function normalizeTemplatePaths(templates: (string | { file: string; name: string })[] | undefined): {
  paths: string[];
  invalidCount: number;
} {
  const paths: string[] = [];
  let invalidCount = 0;
  for (const entry of templates ?? []) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else if (entry !== null && typeof entry === "object" && typeof (entry as { file?: unknown }).file === "string") {
      paths.push((entry as { file: string }).file);
    } else {
      invalidCount += 1;
    }
  }
  return { paths, invalidCount };
}

/**
 * Turns a page transition's `effect` into the transform its start (enter)
 * or end (exit) state holds, alongside the animated `opacity` (§4.6's
 * keyframe table — values transcribed verbatim from the prototype).
 * `"none"`/`"fade"` never move the frame, only fade it.
 */
function pageTransitionTransform(effect: PageTransitionEffect, phase: "enter-start" | "exit-end"): string {
  if (effect === "slide") return phase === "enter-start" ? "translateX(8%)" : "translateX(-8%)";
  if (effect === "zoom") return phase === "enter-start" ? "scale(1.06)" : "scale(0.94)";
  return "none";
}

/**
 * Background image panel: the data source for the "Choose existing file"
 * dropdown — `GET /api/assets` returns the files currently under `assets/`,
 * ready to pick directly (no re-upload needed). Unrelated to
 * `CanvasController`, and doesn't follow any particular slide's
 * load/reload lifecycle, so it's a standalone top-level function rather
 * than a controller method. Returns an empty array rather than throwing on
 * failure — the dropdown still works empty (e.g. by uploading a new file),
 * and it's not worth breaking the whole panel over this.
 */
export async function fetchAssetList(): Promise<string[]> {
  try {
    const response = await fetch("/api/assets");
    if (!response.ok) return [];
    const body = (await response.json().catch(() => null)) as { entries?: unknown } | null;
    const entries = body?.entries;
    return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export type { ProjectJson };
export { normalizeTemplatePaths, pageTransitionTransform };
