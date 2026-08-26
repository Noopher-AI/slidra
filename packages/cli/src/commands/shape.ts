import { addShape } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `co-motion rect add` / `ellipse add` / `line add` / `path add` (#74).
 *
 * Four thin handlers over the one core `addShape`, mirroring
 * `commands/textbox.ts`'s shape: no defaults invented beyond what SVG
 * itself defines (wave 2 R4/R5) — `--fill`/`--stroke` stay opaque text, and
 * `line add`'s `--stroke` is required rather than defaulted.
 */

interface ShapeCommandBase {
  id: string;
  /** Virtual path, e.g. "slides/001.svg". */
  slidePath: string;
}

export interface RectAddInput extends ShapeCommandBase {
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
}

export interface EllipseAddInput extends ShapeCommandBase {
  x: number;
  y: number;
  rx: number;
  ry: number;
  fill?: string;
}

export interface LineAddInput extends ShapeCommandBase {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth?: number;
}

export interface PathAddInput extends ShapeCommandBase {
  x: number;
  y: number;
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface ShapeAddData {
  elementId: string;
}

export const rectAddCommand: CommandHandler<RectAddInput, ShapeAddData> = async (input) => {
  const { elementId } = await addShape(input.id, input.slidePath, {
    kind: "rect",
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    fill: input.fill,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 建立矩形 ${elementId}` };
};

export const ellipseAddCommand: CommandHandler<EllipseAddInput, ShapeAddData> = async (input) => {
  const { elementId } = await addShape(input.id, input.slidePath, {
    kind: "ellipse",
    x: input.x,
    y: input.y,
    rx: input.rx,
    ry: input.ry,
    fill: input.fill,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 建立橢圓 ${elementId}` };
};

export const lineAddCommand: CommandHandler<LineAddInput, ShapeAddData> = async (input) => {
  const { elementId } = await addShape(input.id, input.slidePath, {
    kind: "line",
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
    stroke: input.stroke,
    strokeWidth: input.strokeWidth,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 建立線 ${elementId}` };
};

export const pathAddCommand: CommandHandler<PathAddInput, ShapeAddData> = async (input) => {
  const { elementId } = await addShape(input.id, input.slidePath, {
    kind: "path",
    x: input.x,
    y: input.y,
    d: input.d,
    fill: input.fill,
    stroke: input.stroke,
    strokeWidth: input.strokeWidth,
  });
  return { ok: true, data: { elementId }, message: `已在 ${input.slidePath} 建立 path ${elementId}` };
};
