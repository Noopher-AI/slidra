export interface NotesProps {
  /** #55 的網格檢視要藏起備忘稿。用 [hidden]，不是條件式卸載。 */
  hidden?: boolean;
}

/**
 * The notes pane (#52's other half). No ticket in this fleet wires real
 * note content onto `CanvasState` yet, so this always reads the same
 * honest placeholder base-shell.html itself uses — never a fabricated
 * per-slide note, and never an editable field with nothing behind it.
 */
export function Notes({ hidden }: NotesProps) {
  return (
    <section className="notes" hidden={hidden}>
      <div className="notes-label">備忘稿</div>
      <div className="notes-empty">這一頁還沒有備忘稿。</div>
    </section>
  );
}
