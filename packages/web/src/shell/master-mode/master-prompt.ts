// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

export interface ApplyMasterMessageInput {
  /** Container-relative path of the template that changed, e.g. `templates/002.svg`. */
  templatePath: string;
  /** The template's `TemplateEntry.name`, or `null` for a bare-string (legacy) entry. */
  templateName: string | null;
  /** `project.slides.length` at the moment the author dispatched the agent. */
  slideCount: number;
}

/**
 * The `/slidra-apply-master` chat message App.tsx sends after saving an
 * edited template (AC3) — plain text through the existing `sendChatText`
 * path (draftWithAgent's own precedent), never a separate API. The agent
 * needs the path (to `slidra cat`/edit by), so it is always present; the
 * name is cosmetic and only shown when the template actually has one
 * (bare-string legacy entries don't).
 */
export function buildApplyMasterMessage({ templatePath, templateName, slideCount }: ApplyMasterMessageInput): string {
  const named = templateName ? `${templatePath} ("${templateName}")` : templatePath;
  return `/slidra-apply-master The template ${named} has changed. Apply the change to all ${slideCount} existing slides.`;
}
