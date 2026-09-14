// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, type MouseEvent } from "react";

export interface UnsavedChangesModalProps {
  /** The deck's own filename (`saveState.fileName`) — named directly in the copy, never a generic "your presentation". */
  fileName: string;
  /** The last write-back failure's reason (`SaveStateWire`'s `phase: "failed"` case), appended to the explanation when present. */
  reason?: string;
  /** `POST /api/save/flush`, then (only on success) the caller's own discard-blocked action retried with `x-slidra-discard-unsaved: 1`. */
  onSaveNow(): void;
  onKeepEditing(): void;
  /** Proceeds with whatever would have lost the unsaved changes (Open/New), `x-slidra-discard-unsaved: 1` set. Never the default action — reachable only by an explicit click, never Enter/Escape/clicking the mask. */
  onDiscard(): void;
}

/**
 * NOOP-422 §4(d): the in-app "you're about to lose unsaved changes" gate for
 * Open/New — `beforeunload` (see `unsaved-guard.ts`) covers a tab close, but
 * a browser gives that dialog no room for an explanation or a Discard
 * choice, so this modal is where both live. Modeled on
 * `SaveTemplateModal`'s mask/dialog skeleton.
 *
 * Button order and defaults are fixed (not a preference): "Save now" is
 * the primary action and the only one that receives `autoFocus` (so Enter
 * saves rather than discards); "Discard changes" is destructive and never
 * autofocused, never triggered by Enter/Escape/clicking outside — losing
 * work must always be one explicit click, never the accidental default.
 */
export function UnsavedChangesModal({ fileName, reason, onSaveNow, onKeepEditing, onDiscard }: UnsavedChangesModalProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onKeepEditing();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeepEditing]);

  function onMaskMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onKeepEditing();
  }

  return (
    <div className="unsaved-changes-modal-mask" onMouseDown={onMaskMouseDown}>
      <div role="dialog" aria-modal="true" aria-label="Unsaved changes" className="unsaved-changes-modal">
        <h2 className="unsaved-changes-modal-title">Unsaved changes</h2>
        <p className="unsaved-changes-modal-text">
          Your last changes have not been written to {fileName} yet.
          {reason ? ` ${reason}` : ""}
        </p>
        <div className="unsaved-changes-modal-actions">
          <button type="button" className="unsaved-changes-modal-save" autoFocus onClick={onSaveNow}>
            Save now
          </button>
          <button type="button" className="unsaved-changes-modal-keep" onClick={onKeepEditing}>
            Keep editing
          </button>
          <button type="button" className="unsaved-changes-modal-discard" onClick={onDiscard}>
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
}
