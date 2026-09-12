import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PAGE_TYPE_LABELS,
  RELATIONSHIP_LABELS,
  RHYTHM_LABELS,
  buildConfirmMessage,
  buildRedoMessage,
  type PlanOutline,
} from "../plan-file.js";

export interface PlanGateModalProps {
  outline: PlanOutline;
  /** Sends one chat message through the same path a hand-typed message takes (App.tsx's `sendChatText`). */
  onSend: (text: string) => void;
  /** Discard: runs `plan delete` (whole `plan/`) through the one canvas write path; the gate closes when the refetch finds no file. */
  onDiscard: () => void;
}

/**
 * The plan-confirmation gate — ppt-master's "⛔ BLOCKING" gate as a product
 * feature. `slidra-plan` writes `plan/outline.md` with `status: draft`
 * and its `questions`; this dialog shows the page plan read-only, one block
 * per question with the agent's recommendation preselected, and three
 * exits (contract §4): "Confirm and build" →
 * `/slidra-build 【計畫確認】…`, "Redo" →
 * `/slidra-plan 【重做】…` (a reason is required), "Discard" →
 * `plan delete`. Deliberately blocking: no close button, Esc does nothing,
 * focus stays inside — a plan must be answered, not dismissed; "Discard" is
 * the one exit that needs no agent.
 */
export function PlanGateModal({ outline, onSend, onDiscard }: PlanGateModalProps) {
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(outline.questions.map((question) => [question.id, question.recommended])),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [overall, setOverall] = useState("");
  const [redoOpen, setRedoOpen] = useState(false);
  const [redoReason, setRedoReason] = useState("");
  const dialogRef = useRef<HTMLFormElement>(null);

  // Focus trap: Tab cycles inside the dialog; Esc is swallowed so the
  // shell's own Escape handlers (deselect, close menus) never fire under
  // the gate and nothing outside it receives keyboard focus.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusables()[0]?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialog!.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  function onConfirm(event: FormEvent): void {
    event.preventDefault();
    onSend(buildConfirmMessage({ choices, notes, overall }));
  }

  function onRedo(): void {
    onSend(buildRedoMessage(redoReason));
  }

  return (
    <div className="plan-gate-mask">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm plan"
        className="plan-gate"
        onSubmit={onConfirm}
      >
        <header className="plan-gate-header">
          <h2 className="plan-gate-title">Confirm Presentation Plan</h2>
          <p className="plan-gate-subtitle">
            The agent drafted a page-by-page plan from your outline (narrative mode: {outline.mode}). Review the pages and questions below, then confirm to start building.
          </p>
        </header>

        <div className="plan-gate-body">
          <div className="plan-gate-table-wrap">
            <table className="plan-gate-table" aria-label="Page-by-page plan">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Relationship</th>
                  <th>Type</th>
                  <th>Rhythm</th>
                  <th>Claim</th>
                </tr>
              </thead>
              <tbody>
                {outline.pages.map((page) => (
                  <tr key={page.n}>
                    <td>{page.n}</td>
                    {/* The relationship is what the planner decided; the
                        page type is only filled in when a known solution fits,
                        so most rows show a dash there. */}
                    <td>{RELATIONSHIP_LABELS[page.relationship]}</td>
                    <td>{page.type === null ? "—" : PAGE_TYPE_LABELS[page.type]}</td>
                    <td>{RHYTHM_LABELS[page.rhythm]}</td>
                    <td>{page.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {outline.questions.map((question) => (
            <fieldset key={question.id} className="plan-gate-question" data-question-id={question.id}>
              <legend className="plan-gate-question-text">{question.question}</legend>
              {question.note && <p className="plan-gate-question-note">{question.note}</p>}
              <div className="plan-gate-options">
                {question.options.map((option) => (
                  <label key={option.value} className="plan-gate-option">
                    <input
                      type="radio"
                      name={`plan-q-${question.id}`}
                      value={option.value}
                      checked={choices[question.id] === option.value}
                      onChange={() => setChoices((prev) => ({ ...prev, [question.id]: option.value }))}
                    />
                    <span>{option.label}</span>
                    {option.value === question.recommended && <span className="plan-gate-recommended">Recommended</span>}
                  </label>
                ))}
              </div>
              {question.free_text && (
                <label className="plan-gate-free-text">
                  <span>Notes</span>
                  <input
                    type="text"
                    value={notes[question.id] ?? ""}
                    onChange={(event) => setNotes((prev) => ({ ...prev, [question.id]: event.target.value }))}
                  />
                </label>
              )}
            </fieldset>
          ))}

          <label className="plan-gate-overall">
            <span>Overall notes (optional)</span>
            <textarea value={overall} onChange={(event) => setOverall(event.target.value)} rows={2} />
          </label>

          {redoOpen && (
            <label className="plan-gate-redo">
              <span>What should the agent redo? (required)</span>
              <textarea
                value={redoReason}
                onChange={(event) => setRedoReason(event.target.value)}
                rows={3}
                autoFocus
                placeholder="e.g. too many pages, merge into six; change page 3 to a compare page"
              />
            </label>
          )}
        </div>

        <footer className="plan-gate-actions">
          <button type="button" className="plan-gate-discard" onClick={onDiscard}>
            Discard
          </button>
          {redoOpen ? (
            <button type="button" className="plan-gate-redo-submit" disabled={redoReason.trim() === ""} onClick={onRedo}>
              Submit Redo
            </button>
          ) : (
            <button type="button" className="plan-gate-redo-open" onClick={() => setRedoOpen(true)}>
              Redo
            </button>
          )}
          <button type="submit" className="plan-gate-confirm">
            Confirm and Build
          </button>
        </footer>
      </form>
    </div>
  );
}
