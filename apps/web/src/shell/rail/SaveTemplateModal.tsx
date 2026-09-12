// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type MouseEvent } from "react";

export interface SaveTemplateModalProps {
  onClose: () => void;
  /** The caller is responsible for calling `template add` with this name and closing this modal on success (on failure, the input stays, letting the existing `CanvasState.error` banner show the reason). */
  onSubmit: (name: string) => void;
}

/**
 * The name-input UI for the thumbnail context menu's "Save as template",
 * modeled on `OutlineModal`'s mask/dialog skeleton (the same visual
 * language as the rename precedent in `settings-dialog-*`). Cancel/Esc/
 * clicking the mask all close it and discard the draft.
 */
export function SaveTemplateModal({ onClose, onSubmit }: SaveTemplateModalProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function onMaskMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="save-template-modal-mask" onMouseDown={onMaskMouseDown}>
      <div role="dialog" aria-modal="true" aria-label="Save as template" className="save-template-modal">
        <h2 className="save-template-modal-title">Save as template</h2>
        <input
          type="text"
          className="save-template-modal-input"
          aria-label="Template name"
          placeholder="Template name"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <div className="save-template-modal-actions">
          <button type="button" className="save-template-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="save-template-modal-submit"
            disabled={name.trim() === ""}
            onClick={() => onSubmit(name)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
