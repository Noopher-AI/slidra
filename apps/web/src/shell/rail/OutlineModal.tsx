// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type MouseEvent } from "react";

export interface OutlineModalProps {
  onClose: () => void;
  /** `Plan with agent` sends the raw outline text (no prefix added — App.tsx assembles `/slidra-plan`'s fixed prefix and sends it as a chat message; by design this component doesn't parse the outline or insert pages itself, and building waits for the plan gate to confirm). The caller is responsible for closing this modal. */
  onSubmit: (outline: string) => void;
}

/**
 * The input UI for `From outline…`/`New slides from outline…`. Cancel/Esc/
 * clicking the mask all close it and discard the draft rather than keeping
 * it for the next time it's opened — every mount starts from a fresh
 * `useState("")`, forgotten on unmount.
 */
export function OutlineModal({ onClose, onSubmit }: OutlineModalProps) {
  const [draft, setDraft] = useState("");

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
    <div className="outline-modal-mask" onMouseDown={onMaskMouseDown}>
      <div role="dialog" aria-modal="true" aria-label="New slides from outline" className="outline-modal">
        <h2 className="outline-modal-title">New slides from outline</h2>
        <textarea
          className="outline-modal-textarea"
          aria-label="Outline"
          placeholder={"One line per section; indent a line to make it a point of the section above…"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="outline-modal-actions">
          <button type="button" className="outline-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="outline-modal-submit"
            disabled={draft.trim() === ""}
            onClick={() => onSubmit(draft)}
          >
            Plan with agent
          </button>
        </div>
      </div>
    </div>
  );
}
