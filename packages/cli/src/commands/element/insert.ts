import { insertSlideElement, type InsertElementInput } from "@co-motion/core";
import type { CommandHandler } from "../../registry.js";

export interface ElementInsertInput {
  id: string;
  slidePath: string;
  kind: InsertElementInput["kind"];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  d?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  href?: string;
  media?: string;
  /** [E2.T17]: `video` only — marks `media` as a third-party player URL. See `@co-motion/core`'s `embed.ts`. */
  embed?: string;
}

export interface ElementInsertData {
  elementId: string;
}

export const elementInsertCommand: CommandHandler<ElementInsertInput, ElementInsertData> = async (input) => {
  const { elementId } = await insertSlideElement(input.id, input.slidePath, {
    kind: input.kind,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
    d: input.d,
    fill: input.fill,
    stroke: input.stroke,
    strokeWidth: input.strokeWidth,
    href: input.href,
    media: input.media,
    embed: input.embed,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 新增元素 ${elementId}` };
};
