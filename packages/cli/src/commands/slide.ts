import { addSlide, deleteSlide, duplicateSlide, moveSlide, setNotes } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `slide add / delete / duplicate / move / notes set` (T3). Thin
 * CommandHandler wrappers over `@co-motion/core`'s `slide-ops.ts` — the file
 * orchestration and id-reminting live there, not here (same split as
 * `element.ts`'s wrappers over `element-edit.ts`/`workspace.ts`).
 */

export interface SlideAddInput {
  id: string;
  /** Virtual path of a template listed in `project.json`'s `templates`. Omit for a blank slide. */
  templatePath?: string;
  /** Insertion index into `slides`. Omit to append at the end. */
  at?: number;
}

export interface SlideAddData {
  slidePath: string;
}

export const slideAddCommand: CommandHandler<SlideAddInput, SlideAddData> = async (input) => {
  const { slidePath } = await addSlide(input.id, { templatePath: input.templatePath, at: input.at });
  return { ok: true, data: { slidePath }, message: `已新增投影片 ${slidePath}` };
};

export interface SlideDeleteInput {
  id: string;
  slidePath: string;
}
export type SlideDeleteData = Record<string, never>;

export const slideDeleteCommand: CommandHandler<SlideDeleteInput, SlideDeleteData> = async (input) => {
  await deleteSlide(input.id, input.slidePath);
  return { ok: true, data: {}, message: `已刪除投影片 ${input.slidePath}` };
};

export interface SlideDuplicateInput {
  id: string;
  slidePath: string;
}

export interface SlideDuplicateData {
  slidePath: string;
}

export const slideDuplicateCommand: CommandHandler<SlideDuplicateInput, SlideDuplicateData> = async (input) => {
  const { slidePath } = await duplicateSlide(input.id, input.slidePath);
  return { ok: true, data: { slidePath }, message: `已複製投影片為 ${slidePath}` };
};

export interface SlideMoveInput {
  id: string;
  slidePath: string;
  newIndex: number;
}
export type SlideMoveData = Record<string, never>;

export const slideMoveCommand: CommandHandler<SlideMoveInput, SlideMoveData> = async (input) => {
  await moveSlide(input.id, input.slidePath, input.newIndex);
  return { ok: true, data: {}, message: `已搬移投影片 ${input.slidePath}` };
};

export interface SlideNotesSetInput {
  id: string;
  slidePath: string;
  text: string;
}
export type SlideNotesSetData = Record<string, never>;

export const slideNotesSetCommand: CommandHandler<SlideNotesSetInput, SlideNotesSetData> = async (input) => {
  await setNotes(input.id, input.slidePath, input.text);
  return { ok: true, data: {}, message: `已更新 ${input.slidePath} 的備忘稿` };
};
