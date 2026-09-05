import { addTemplate, listTemplates, renameTemplate, deleteTemplate, type TemplateEntry } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

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
  /** User-visible name (trimmed). Omit to default to the new file's basename. */
  name?: string;
}

export interface TemplateAddData {
  templatePath: string;
}

export const templateAddCommand: CommandHandler<TemplateAddInput, TemplateAddData> = async (input) => {
  const { templatePath } = await addTemplate(input.id, { from: input.from, name: input.name });
  return { ok: true, data: { templatePath }, message: `已建立範本 ${templatePath}` };
};

export interface TemplateListInput {
  id: string;
}

export interface TemplateListData {
  templates: TemplateEntry[];
}

/** `template list` ([E4.T7], A10) — the dialog's read side; every field the front-end dialog needs is already here (ADR-0002). */
export const templateListCommand: CommandHandler<TemplateListInput, TemplateListData> = async (input) => {
  const templates = await listTemplates(input.id);
  return { ok: true, data: { templates }, message: `共 ${templates.length} 個範本` };
};

export interface TemplateRenameInput {
  id: string;
  templatePath: string;
  newName: string;
}

/** `template rename` ([E4.T7], A5/A6/A10) — renames `templates[i].name` only, never the file. */
export const templateRenameCommand: CommandHandler<TemplateRenameInput, void> = async (input) => {
  await renameTemplate(input.id, input.templatePath, input.newName);
  return { ok: true, message: `已將範本改名為 ${input.newName.trim()}` };
};

export interface TemplateDeleteInput {
  id: string;
  templatePath: string;
}

/** `template delete` ([E4.T7], A8/A9/A10) — ADR-0013: never touches slides already built from this template. */
export const templateDeleteCommand: CommandHandler<TemplateDeleteInput, void> = async (input) => {
  await deleteTemplate(input.id, input.templatePath);
  return { ok: true, message: `已刪除範本 ${input.templatePath}` };
};

export function register(registry: CommandRegistry): void {
  registry.register("template add", { handler: templateAddCommand, render: null });
  registry.register("template list", { handler: templateListCommand, render: null });
  registry.register("template rename", { handler: templateRenameCommand, render: null });
  registry.register("template delete", { handler: templateDeleteCommand, render: null });
}
