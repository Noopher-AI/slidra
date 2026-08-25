import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CoMotionError,
  CoMotionNotFoundError,
  generateElementId,
  listPresentationEntries,
  normaliseSlideSvg,
  readPresentationFile,
  resolveWorkDir,
  type ProjectJson,
} from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `co-motion convert <presentation-id>` — the author-initiated conversion
 * of a presentation's slides into the compliant container form (ADR-0012).
 *
 * ## Why the file-writing half lives here and not in core
 *
 * The maths and the normalisation itself are in `@co-motion/core`
 * (`slide/normalise.ts`), where the front end can reach them. That module
 * is required to stay free of Node built-ins (跨波接縫 2 for this wave),
 * and reading and writing files is exactly what a Node built-in is for. So
 * the split is: core decides what the bytes should become, and this command
 * is the one place in the codebase that puts them on disk.
 *
 * ## Never half-converted
 *
 * A presentation where three slides are in the container form and the
 * fourth is not is a worse state than the one the author started in, so
 * this command guards both ways it could happen:
 *
 * - Every slide is read and normalised BEFORE anything is written, so one
 *   unconvertible slide aborts the run with not a single byte written.
 * - The write loop keeps each slide's original bytes and rolls the already-
 *   written slides back if a later write fails (see `rollBack`), so a disk
 *   that accepts three writes and refuses the fourth does not leave a
 *   mixed-format presentation behind either.
 *
 * ## Conversion is not something that happens to you
 *
 * AC 2: opening a presentation must never rewrite it. Structurally, not by
 * discipline — `openPresentation`, `readPresentationFile` and
 * `setElementText` have no path to this module at all; this command is the
 * only caller of `normaliseSlideSvg` that writes anything.
 */

export interface ConvertInput {
  id: string;
}

export interface ConvertSlideOutcome {
  slidePath: string;
  changed: boolean;
  /** How many containers this slide gained. */
  wrapped: number;
}

export interface ConvertReport {
  slides: ConvertSlideOutcome[];
}

export type ConvertData = ConvertReport;

/** One slide, read and normalised, waiting for the write phase. */
interface PendingSlide {
  slidePath: string;
  /** Real filesystem path. Internal only — never surfaced in any message (ADR-0004). */
  realPath: string;
  /** The normalised document. */
  svg: string;
  /** The bytes on disk before this run, kept so a failed write can be rolled back. */
  original: string;
  wrapped: number;
}

export const convertCommand: CommandHandler<ConvertInput, ConvertData> = async (input) => {
  const report = await convertPresentationSlides(input.id);
  const changed = report.slides.filter((slide) => slide.changed).length;
  const untouched = report.slides.length - changed;
  return { ok: true, data: report, message: describe(changed, untouched) };
};

function describe(changed: number, untouched: number): string {
  if (changed === 0 && untouched === 0) return "沒有投影片需要轉換";
  if (untouched === 0) return `已轉換 ${changed} 張投影片`;
  return `已轉換 ${changed} 張投影片，${untouched} 張原本就合規`;
}

/**
 * Normalises every slide listed in the presentation's `project.json` and
 * writes the results back. The only function in the codebase that persists
 * a normalisation.
 */
export async function convertPresentationSlides(id: string): Promise<ConvertReport> {
  const workDir = await resolveWorkDir(id);
  const project = await readProject(id);

  const pending: PendingSlide[] = [];
  for (const slidePath of project.slides) {
    const original = await readPresentationFile(id, slidePath);
    const realPath = await resolveRealPath(id, workDir, slidePath);
    let result;
    try {
      result = normaliseSlideSvg(original, { generateId: generateElementId });
    } catch (error) {
      if (error instanceof CoMotionError) {
        throw new CoMotionError(`${slidePath}：${error.message}整份簡報都沒有被修改。`);
      }
      throw error;
    }
    pending.push({ slidePath, realPath, svg: result.svg, original, wrapped: result.wrapped });
  }

  const slides: ConvertSlideOutcome[] = [];
  /** Slides already written this run, newest last — the undo log for a mid-write failure. */
  const written: typeof pending = [];

  for (const slide of pending) {
    const changed = slide.svg !== slide.original;
    if (changed) {
      try {
        await writeFile(slide.realPath, slide.svg, "utf-8");
      } catch {
        // slide.realPath is a real filesystem path (ADR-0004) — never quote it.
        throw new CoMotionError(await rollBack(written, slide.slidePath));
      }
      written.push(slide);
    }
    slides.push({ slidePath: slide.slidePath, changed, wrapped: slide.wrapped });
  }
  return { slides };
}

/**
 * Puts back every slide this run had already rewritten before one of them
 * failed to write, and returns the message describing what actually
 * happened on disk.
 *
 * Reading and normalising every slide up front (the first loop) makes an
 * unconvertible slide harmless — nothing is written at all. It does NOT
 * make a failing *write* harmless: the disk is a shared, mutable thing that
 * can refuse the fourth write after accepting three, which would leave the
 * presentation half in the container form and half not. Gate round 1
 * reproduced exactly that with a read-only `slides/004.svg`.
 *
 * Restoring is best-effort, because the same disk that just refused a write
 * can refuse the restore too. So the message is assembled from what was
 * actually observed, never from what was intended: only a fully successful
 * rollback is allowed to claim the presentation is untouched, and a partial
 * one names the slides left in the new format. A reassuring message that
 * does not match the disk is worse than no message — it sends the author
 * looking for the problem in the wrong place.
 */
async function rollBack(written: readonly PendingSlide[], failedSlidePath: string): Promise<string> {
  const notRestored: string[] = [];
  for (const slide of written) {
    try {
      await writeFile(slide.realPath, slide.original, "utf-8");
    } catch {
      notRestored.push(slide.slidePath);
    }
  }
  const failure = `寫入投影片時發生錯誤：${failedSlidePath}。`;
  if (notRestored.length === 0) {
    return `${failure}整份簡報都沒有被修改。`;
  }
  return (
    `${failure}已改寫的投影片還原失敗，這幾張現在是轉換後的格式，其餘維持原樣：` +
    `${notRestored.join("、")}。請修復磁碟問題後重新執行 convert。`
  );
}

async function readProject(id: string): Promise<ProjectJson> {
  const raw = await readPresentationFile(id, "project.json");
  let project: ProjectJson;
  try {
    project = JSON.parse(raw) as ProjectJson;
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  if (!Array.isArray(project.slides)) {
    throw new CoMotionError("簡報設定檔已損毀：沒有 slides 清單");
  }
  return project;
}

/**
 * Turns a virtual slide path into the real file to write, without ever
 * joining caller-supplied text onto the work directory: every segment is
 * first proven to exist by listing its parent, so the path is assembled out
 * of names the filesystem itself produced (ADR-0004, third layer — the same
 * structural rule `virtual-fs.ts` enforces on the read side).
 */
async function resolveRealPath(id: string, workDir: string, virtualPath: string): Promise<string> {
  const segments = virtualPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new CoMotionNotFoundError(`找不到檔案：${virtualPath}`);
  }
  let realPath = workDir;
  let walked = "";
  for (const segment of segments) {
    const entries = await listPresentationEntries(id, walked);
    const found = entries.find((entry) => entry === segment);
    if (found === undefined) {
      throw new CoMotionNotFoundError(`找不到檔案：${virtualPath}`);
    }
    realPath = path.join(realPath, found);
    walked = walked ? `${walked}/${found}` : found;
  }
  return realPath;
}
