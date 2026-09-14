// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useTemplateList } from "../rail/useTemplateList.js";

type RunCommand = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;

export interface MasterModeBarProps {
  runCommand: RunCommand;
  /** The template path currently on stage (`CanvasState.slides[currentIndex]` while `pageSource === "templates"`), or `null` when the deck has none. */
  currentTemplatePath: string | null;
  /** Agent holds the editing lock (mirrors `App.tsx`'s `editingFrozen` gate on Save/undo/redo). */
  disabled: boolean;
  /** "Let the agent update the slides" (AC3) — the caller (App.tsx) saves the template and dispatches `buildApplyMasterMessage`; this component only resolves the current path to its display name (when it has one) before handing off. */
  onApply: (templateName: string | null) => void;
}

/**
 * Master mode's own explanatory strip + dispatch action (AC3/AC5) — shown
 * in place of the ordinary slide chrome while `pageSource === "templates"`
 * (Rail.tsx mounts this only then, so `useTemplateList` here always
 * re-fetches fresh on entry, same "mount IS just opened" contract its own
 * doc comment describes for its other two callers).
 */
export function MasterModeBar({ runCommand, currentTemplatePath, disabled, onApply }: MasterModeBarProps) {
  const templateList = useTemplateList(runCommand);
  const currentTemplate =
    templateList.status === "ready" && currentTemplatePath !== null
      ? (templateList.templates.find((entry) => entry.file === currentTemplatePath) ?? null)
      : null;

  return (
    <div className="master-mode-bar">
      <p className="master-mode-bar-hint">Editing this template. Existing slides don't change until you use the action below.</p>
      <button
        type="button"
        className="master-mode-bar-apply"
        disabled={disabled || currentTemplatePath === null}
        onClick={() => onApply(currentTemplate?.name ?? null)}
      >
        Let the agent update the slides
      </button>
    </div>
  );
}
