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
 * Every slide is read and normalised first, and only then is anything
 * written. One unconvertible slide aborts the whole run with not a single
 * byte written — a presentation where three slides are compliant and the
 * fourth is not is a worse state to be in than the one the author started
 * with.
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

  const pending: Array<{ slidePath: string; realPath: string; svg: string; original: string; wrapped: number }> = [];
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
  for (const slide of pending) {
    const changed = slide.svg !== slide.original;
    if (changed) {
      try {
        await writeFile(slide.realPath, slide.svg, "utf-8");
      } catch {
        // slide.realPath is a real filesystem path (ADR-0004) — never quote it.
        throw new CoMotionError(`寫入投影片時發生錯誤：${slide.slidePath}`);
      }
    }
    slides.push({ slidePath: slide.slidePath, changed, wrapped: slide.wrapped });
  }
  return { slides };
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
