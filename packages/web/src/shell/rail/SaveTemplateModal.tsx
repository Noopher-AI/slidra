import { useEffect, useState, type MouseEvent } from "react";

export interface SaveTemplateModalProps {
  onClose: () => void;
  /** 呼叫端負責用這個名稱呼叫 `template add` 並在成功時關閉這個 modal（失敗時保留輸入，讓既有的 `CanvasState.error` 橫幅顯示原因）。 */
  onSubmit: (name: string) => void;
}

/**
 * 縮圖右鍵選單「Save as template」的名稱輸入 UI，仿 `OutlineModal` 的
 * mask/dialog 骨架（同一份視覺語言，見 `settings-dialog-*` 的重命名前
 * 例）。Cancel／Esc／點遮罩一律關閉並丟棄草稿。
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
