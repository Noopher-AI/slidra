// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * NOOP-422 §4(d): blocks a tab close/reload while the deck has unwritten
 * changes. No modern browser lets a page customize this dialog's text or
 * buttons — the only thing `beforeunload` can control is whether the
 * dialog appears at all, so that is all this module does. The explanation
 * and an explicit Discard choice live in `UnsavedChangesModal` instead,
 * for the in-app Open/New case, which a browser dialog cannot express.
 *
 * `isDirty` is read at the moment of the event, not captured once — so the
 * caller never has to re-install this on every save-state change.
 */
export function installUnsavedGuard(isDirty: () => boolean): () => void {
  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!isDirty()) return;
    event.preventDefault();
    // Legacy requirement for some browsers to actually show the prompt —
    // the string itself is never shown, the browser supplies its own text.
    event.returnValue = "";
  }
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
}
