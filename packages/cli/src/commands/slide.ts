import { addSlide, deleteSlide, duplicateSlide, moveSlide } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `co-motion slide add` / `slide delete` / `slide duplicate` / `slide move`
 * (#85): slide-level presentation operations, one handler per verb,
 * modelled on `element.ts`'s `elementDeleteCommand` shape. All four take
 * their `--at`/`--to` positions 1-based (ADR-0002: a command's arguments
 * are the product's vocabulary, and the author counts pages from 1).
 */

export interface SlideAddInput {
  id: string;
  at?: number;
}

export interface SlideAddData {
  slidePath: string;
  /** 1-based page position of the new slide. */
  index: number;
}

export const slideAddCommand: CommandHandler<SlideAddInput, SlideAddData> = async (input) => {
  const { slidePath, index } = await addSlide(input.id, { at: input.at });
  return {
    ok: true,
    data: { slidePath, index },
    message: `已新增投影片 ${slidePath}（第 ${index} 頁）`,
  };
};

export interface SlideDeleteInput {
  id: string;
  slidePath: string;
}

export interface SlideDeleteData {
  slidePath: string;
  remaining: number;
}

export const slideDeleteCommand: CommandHandler<SlideDeleteInput, SlideDeleteData> = async (input) => {
  const { slidePath, remaining } = await deleteSlide(input.id, input.slidePath);
  return {
    ok: true,
    data: { slidePath, remaining },
    message: `已刪除投影片 ${slidePath}，剩餘 ${remaining} 頁`,
  };
};

export interface SlideDuplicateInput {
  id: string;
  slidePath: string;
}

export interface SlideDuplicateData {
  /** Path of the NEW (duplicated) slide. */
  slidePath: string;
  /** 1-based page position of the new slide. */
  index: number;
}

export const slideDuplicateCommand: CommandHandler<SlideDuplicateInput, SlideDuplicateData> = async (input) => {
  const { slidePath, index } = await duplicateSlide(input.id, input.slidePath);
  return {
    ok: true,
    data: { slidePath, index },
    message: `已複製投影片為 ${slidePath}（第 ${index} 頁）`,
  };
};

export interface SlideMoveInput {
  id: string;
  slidePath: string;
  to: number;
}

export interface SlideMoveData {
  slidePath: string;
  from: number;
  to: number;
  changed: boolean;
}

export const slideMoveCommand: CommandHandler<SlideMoveInput, SlideMoveData> = async (input) => {
  const { from, to, changed } = await moveSlide(input.id, input.slidePath, input.to);
  return {
    ok: true,
    data: { slidePath: input.slidePath, from, to, changed },
    message: changed ? `已將投影片從第 ${from} 頁移到第 ${to} 頁` : "順序未變",
  };
};
