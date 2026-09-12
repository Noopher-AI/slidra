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
 * exits (contract §4): "確認並建置" (Confirm and build) →
 * `/slidra-build 【計畫確認】…`, "重新規劃" (Redo) →
 * `/slidra-plan 【重做】…` (a reason is required), "放棄" (Discard) →
 * `plan delete`. Deliberately blocking: no close button, Esc does nothing,
 * focus stays inside — a plan must be answered, not dismissed; "放棄" is
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
        aria-label="確認計畫"
        className="plan-gate"
        onSubmit={onConfirm}
      >
        <header className="plan-gate-header">
          <h2 className="plan-gate-title">確認簡報計畫</h2>
          <p className="plan-gate-subtitle">
            agent 依大綱擬好了逐頁計畫（敘事骨架：{outline.mode}）。看過下面的頁面與問題，確認後才會開始建置。
          </p>
        </header>

        <div className="plan-gate-body">
          <div className="plan-gate-table-wrap">
            <table className="plan-gate-table" aria-label="逐頁計畫">
              <thead>
                <tr>
                  <th>頁碼</th>
                  <th>關係</th>
                  <th>頁型</th>
                  <th>節奏</th>
                  <th>主張</th>
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
                    {option.value === question.recommended && <span className="plan-gate-recommended">建議</span>}
                  </label>
                ))}
              </div>
              {question.free_text && (
                <label className="plan-gate-free-text">
                  <span>補充</span>
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
            <span>整體補充（可空）</span>
            <textarea value={overall} onChange={(event) => setOverall(event.target.value)} rows={2} />
          </label>

          {redoOpen && (
            <label className="plan-gate-redo">
              <span>要 agent 怎麼重做（必填）</span>
              <textarea
                value={redoReason}
                onChange={(event) => setRedoReason(event.target.value)}
                rows={3}
                autoFocus
                placeholder="例如：頁數太多，合併成六頁；第 3 頁改成對照頁"
              />
            </label>
          )}
        </div>

        <footer className="plan-gate-actions">
          <button type="button" className="plan-gate-discard" onClick={onDiscard}>
            放棄
          </button>
          {redoOpen ? (
            <button type="button" className="plan-gate-redo-submit" disabled={redoReason.trim() === ""} onClick={onRedo}>
              送出重做
            </button>
          ) : (
            <button type="button" className="plan-gate-redo-open" onClick={() => setRedoOpen(true)}>
              重新規劃
            </button>
          )}
          <button type="submit" className="plan-gate-confirm">
            確認並建置
          </button>
        </footer>
      </form>
    </div>
  );
}
