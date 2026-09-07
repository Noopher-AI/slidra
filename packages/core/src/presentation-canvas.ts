import { CoMotionError } from "./errors.js";
import { applySplices, setAttrSplice } from "./element-text.js";
import { assertSlideCompliant } from "./slide/format.js";
import { scanDocument } from "./slide/scan.js";
import { formatSvgNumber } from "./svg-number.js";
import { validateProjectJson, type ProjectJson } from "./project-json.js";
import { readPresentationFile, writePresentationFileWithoutHistory } from "./workspace.js";

/**
 * `presentation canvas set` (#200 §4.3/§4.4): resizes the presentation's
 * page — `project.json`'s `canvas` and every slide's root `<svg>`'s
 * `viewBox`. Deliberately the ONE command that never touches an element's
 * own `transform`/geometry (#200 決定 6): a slide whose elements now sit
 * outside the new bounds, or leave blank space, is the intended, literal
 * result — nothing here "helpfully" rescales content to fit.
 */

const MIN_CANVAS_DIMENSION = 320;
const MAX_CANVAS_DIMENSION = 4096;

/** Validates a canvas width/height against the panel's declared 320–4096 range (`docs/design/prototype/comotion-logic-v3.js:571-573`). Never clamps — an out-of-range value is rejected, not silently squeezed to the boundary. */
export function assertValidCanvasDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value < MIN_CANVAS_DIMENSION || value > MAX_CANVAS_DIMENSION) {
    throw new CoMotionError(`${label} 必須是 ${MIN_CANVAS_DIMENSION} 到 ${MAX_CANVAS_DIMENSION} 之間的整數：${value}`);
  }
}

/**
 * Pure `svgContent -> svgContent`: rewrites the root `<svg>`'s `viewBox` to
 * `0 0 width height`. Every other byte — every element's own `transform`,
 * every primitive's own attributes — is untouched.
 */
export function setSlideViewBox(svgContent: string, slidePath: string, width: number, height: number): string {
  assertSlideCompliant(svgContent, slidePath);
  const svgRoot = scanDocument(svgContent).find((node) => node.tag === "svg")!;
  const viewBox = `0 0 ${formatSvgNumber(width)} ${formatSvgNumber(height)}`;
  return applySplices(svgContent, [setAttrSplice(svgRoot, "viewBox", viewBox)]);
}

export interface PresentationCanvasResult {
  readonly width: number;
  readonly height: number;
}

/**
 * `co-motion presentation canvas set` (#200 §4.3): resizes `project.json`'s
 * `canvas` and every listed slide's `viewBox` together. Deliberately does
 * NOT go through `writePresentationFile` (#200 決定 4 — "Undo 可回退（頁面
 * 尺寸除外）"): every write here uses `writePresentationFileWithoutHistory`,
 * so this never occupies an undo step and undoing an unrelated edit never
 * reverts the canvas size back.
 *
 * A same-size request is a legal no-op (§4.6 table) — returning early
 * before any write means it costs zero `presentation-changed` events, not
 * one-per-slide for a size that never actually changed.
 */
export async function setPresentationCanvas(id: string, width: number, height: number): Promise<PresentationCanvasResult> {
  assertValidCanvasDimension(width, "width");
  assertValidCanvasDimension(height, "height");

  const raw = await readPresentationFile(id, "project.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError("簡報設定檔已損毀");
  }
  const project = validateProjectJson(parsed);

  if (project.canvas.width === width && project.canvas.height === height) {
    return { width, height };
  }

  const nextProject: ProjectJson = { ...project, canvas: { width, height } };
  await writePresentationFileWithoutHistory(id, "project.json", `${JSON.stringify(nextProject, null, 2)}\n`);

  for (const slidePath of project.slides) {
    const svg = await readPresentationFile(id, slidePath);
    const updated = setSlideViewBox(svg, slidePath, width, height);
    await writePresentationFileWithoutHistory(id, slidePath, updated);
  }

  return { width, height };
}
