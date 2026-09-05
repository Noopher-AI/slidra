import { useEffect, useState, type MouseEvent } from "react";

export interface OutlineModalProps {
  onClose: () => void;
}

/**
 * `From outline…`／`New slides from outline…` 的輸入 UI（T3 plan §2 邊界
 * 3）。只做輸入；送出是 F13 的聊天訊息，所以 `Draft with agent` 永遠
 * `disabled`——這是「入口已備好、執行在別票」的誠實表現形式，不接受送聊
 * 天訊息、關掉 modal 假裝成功、或自己插頁這三種替代方案（T3 plan §7 決定
 * 5）。Cancel／Esc／點遮罩一律關閉並丟棄草稿，不保留到下次開啟——每次掛
 * 載都是全新的 `useState("")`，卸載即遺忘。
 */
export function OutlineModal({ onClose }: OutlineModalProps) {
  const [draft, setDraft] = useState("");
  const lineCount = draft.split("\n").filter((line) => line.trim() !== "").length;

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
          placeholder={"One line per slide…"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="outline-modal-counter">
          {lineCount} {lineCount === 1 ? "line" : "lines"} · {lineCount} {lineCount === 1 ? "slide" : "slides"}
        </div>
        <div className="outline-modal-actions">
          <button type="button" className="outline-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="outline-modal-submit"
            disabled
            aria-disabled="true"
            title="Draft with agent runs in a later ticket — this entry point is not wired up yet"
          >
            Draft with agent
          </button>
        </div>
      </div>
    </div>
  );
}
