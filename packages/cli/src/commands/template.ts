import { addTemplate } from "@co-motion/core";
import type { CommandHandler } from "../registry.js";

/**
 * `template add` (T3, ADR-0013). The only door a template ever comes into
 * existence through — see the plan's "開工前對帳" note: without this
 * command, `templates` in `project.json` would only ever be reachable by
 * hand-editing the container, which ADR-0002 forbids.
 */

export interface TemplateAddInput {
  id: string;
  /** Virtual path of an existing slide to copy from. Omit for a blank template. */
  from?: string;
}

export interface TemplateAddData {
  templatePath: string;
}

export const templateAddCommand: CommandHandler<TemplateAddInput, TemplateAddData> = async (input) => {
  const { templatePath } = await addTemplate(input.id, { from: input.from });
  return { ok: true, data: { templatePath }, message: `已建立範本 ${templatePath}` };
};
