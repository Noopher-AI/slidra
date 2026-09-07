import { addSlide, deleteSlide, duplicateSlide, moveSlide, setNotes, setSlideTransitionOn } from "@co-motion/core";
import type { PageTransitionEffect } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

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

export interface SlideTransitionSetInput {
  id: string;
  slidePath: string;
  enter?: PageTransitionEffect;
  enterDuration?: number;
  exit?: PageTransitionEffect;
  exitDuration?: number;
  all?: boolean;
}
export type SlideTransitionSetData = Record<string, never>;

/** `slide transition set` ([E2.T11]) — replaces T3's `presentation transition set` (removed). */
export const slideTransitionSetCommand: CommandHandler<SlideTransitionSetInput, SlideTransitionSetData> = async (input) => {
  const { slideCount } = await setSlideTransitionOn(
    input.id,
    input.slidePath,
    { enter: input.enter, enterDuration: input.enterDuration, exit: input.exit, exitDuration: input.exitDuration },
    { all: input.all },
  );
  const message = input.all ? `已將頁面進出場套用到 ${slideCount} 張投影片` : `已設定 ${input.slidePath} 的頁面進出場`;
  return { ok: true, data: {}, message };
};

export function register(registry: CommandRegistry): void {
  registry.register("slide add", { handler: slideAddCommand, render: null });
  registry.register("slide delete", { handler: slideDeleteCommand, render: null });
  registry.register("slide duplicate", { handler: slideDuplicateCommand, render: null });
  registry.register("slide move", { handler: slideMoveCommand, render: null });
  registry.register("slide notes set", { handler: slideNotesSetCommand, render: null });
  registry.register("slide transition set", { handler: slideTransitionSetCommand, render: null });
}
