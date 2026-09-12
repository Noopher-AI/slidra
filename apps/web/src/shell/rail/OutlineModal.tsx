import { useEffect, useState, type MouseEvent } from "react";

export interface OutlineModalProps {
  onClose: () => void;
  /** [E2.T8]／#303：`Plan with agent` 送出大綱原文（未加前綴——App.tsx 組 `/comotion-plan` 的固定前綴並送出聊天訊息，架構拍板：不解析大綱、不自己插頁；建置要等計畫閘門確認）。呼叫端負責關閉這個 modal。 */
  onSubmit: (outline: string) => void;
}

/**
 * `From outline…`／`New slides from outline…` 的輸入 UI（T3 plan §2 邊界
 * 3，[E2.T8] 接上送出）。Cancel／Esc／點遮罩一律關閉並丟棄草稿，不保留到
 * 下次開啟——每次掛載都是全新的 `useState("")`，卸載即遺忘。
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
