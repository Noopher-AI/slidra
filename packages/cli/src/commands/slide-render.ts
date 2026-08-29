import { renderSlideForDisplay } from "@co-motion/core";
import { renderCat } from "./cat.js";
import type { CommandHandler, TerminalRenderer } from "../registry.js";

export interface SlideRenderInput {
  id: string;
  /** Virtual path of the slide, e.g. "slides/001.svg". */
  path: string;
}

export interface SlideRenderData {
  content: string;
}

/**
 * The display-time counterpart to `cat` for a slide path: same shape, but
 * `{{ slide_number }}` / `{{ slide_total }}` / `{{ presentation_name }}`
 * are substituted first (NOOP-90/T4). `co-motion serve`'s `/api/files/`
 * route dispatches here for a path listed in `project.json`'s `slides`,
 * and keeps dispatching `cat` for every other path (`project.json`,
 * `assets/*`) — `cat`'s byte-exact contract is untouched.
 */
export const slideRenderCommand: CommandHandler<SlideRenderInput, SlideRenderData> = async (input) => {
  const content = await renderSlideForDisplay(input.id, input.path);
  return {
    ok: true,
    data: { content },
    message: `已渲染：${input.path}`,
  };
};

export const renderSlideRender: TerminalRenderer<SlideRenderData> = renderCat;
