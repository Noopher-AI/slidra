import { useEffect, useState } from "react";
import type { TemplateInfo } from "../presentation.js";
import { wrapSlideDocument } from "../overview.js";

export interface TemplateCommandResult {
  ok: boolean;
  message: string;
}

export interface TemplateDialogProps {
  templates: TemplateInfo[];
  /** false when there is no current slide to save ([E4.T7]'s 存成範本 button gate). */
  canSaveCurrent: boolean;
  onClose(): void;
  onSaveCurrent(name: string): Promise<TemplateCommandResult>;
  onRename(templatePath: string, newName: string): Promise<TemplateCommandResult>;
  onDelete(templatePath: string): Promise<TemplateCommandResult>;
}

/** srcdoc per template file, keyed by `TemplateInfo.file`. Fetched fresh every time this component mounts/its `templates` prop changes — no cache layer (決定 8 of the [E4.T7] 前端計畫). */
type ThumbnailState = Record<string, string>;

/**
 * 範本管理對話框 ([E4.T7]). Presentational: every write goes out through the
 * three callback props, which App.tsx wires to `controller.runCommand`'s
 * `template add`/`rename`/`delete` (the only three CLI-backed operations —
 * ADR-0002). This component never calls `template list` itself; its list
 * comes from `PresentationInfo.templates`, which already tracks live-reload.
 */
export function TemplateDialog({
  templates,
  canSaveCurrent,
  onClose,
  onSaveCurrent,
  onRename,
  onDelete,
}: TemplateDialogProps) {
  const [thumbnails, setThumbnails] = useState<ThumbnailState>({});

  const [savingOpen, setSavingOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const [confirmingDeleteFile, setConfirmingDeleteFile] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 只在對話框開著（此元件掛載）時抓縮圖；元件卸載即釋放，不做預抓或快取層。
  useEffect(() => {
    let cancelled = false;
    setThumbnails({});
    for (const template of templates) {
      void (async () => {
        let srcdoc: string;
        try {
          const response = await fetch(`/api/files/${template.file}`);
          if (!response.ok) throw new Error("縮圖載入失敗");
          const markup = await response.text();
          srcdoc = wrapSlideDocument(markup, "/api/raw/templates/");
        } catch {
          srcdoc = wrapSlideDocument("<p>縮圖載入失敗</p>");
        }
        if (cancelled) return;
        setThumbnails((prev) => ({ ...prev, [template.file]: srcdoc }));
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [templates]);

  // 對話框開著時 live-reload 推來變更：正在改名／刪除確認的那一列若其 file
  // 已從 templates 消失，結束該列的編輯狀態（§4.2 最後一行）。
  useEffect(() => {
    if (renamingFile && !templates.some((t) => t.file === renamingFile)) {
      setRenamingFile(null);
      setRenameDraft("");
      setRenameError(null);
    }
    if (confirmingDeleteFile && !templates.some((t) => t.file === confirmingDeleteFile)) {
      setConfirmingDeleteFile(null);
      setDeleteError(null);
    }
  }, [templates, renamingFile, confirmingDeleteFile]);

  function openSaving(): void {
    if (!canSaveCurrent) return;
    setNewName("");
    setSaveError(null);
    setSavingOpen(true);
  }

  /** 取消：不送任何命令，只關掉命名輸入（A4）。 */
  function cancelSaving(): void {
    setSavingOpen(false);
    setNewName("");
    setSaveError(null);
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    const result = await onSaveCurrent(newName);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setSavingOpen(false);
    setNewName("");
    setSaveError(null);
  }

  function startRename(template: TemplateInfo): void {
    setRenamingFile(template.file);
    setRenameDraft(template.name);
    setRenameError(null);
  }

  function cancelRename(): void {
    setRenamingFile(null);
    setRenameDraft("");
    setRenameError(null);
  }

  async function handleRenameConfirm(file: string): Promise<void> {
    const result = await onRename(file, renameDraft);
    if (!result.ok) {
      setRenameError(result.message);
      return;
    }
    setRenamingFile(null);
    setRenameDraft("");
    setRenameError(null);
  }

  async function handleDeleteConfirm(file: string): Promise<void> {
    const result = await onDelete(file);
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    setConfirmingDeleteFile(null);
    setDeleteError(null);
  }

  return (
    <div
      className="template-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="template-dialog" role="dialog" aria-modal="true" aria-label="範本管理">
        <div className="template-dialog-header">
          <h2>範本管理</h2>
          <button
            type="button"
            className="template-dialog-close"
            aria-label="關閉"
            title="關閉"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {savingOpen ? (
          <div className="template-dialog-save" aria-busy={saving}>
            <input
              type="text"
              value={newName}
              placeholder="範本名稱"
              autoFocus
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                // Enter 一律嘗試送出，不受下面「確定」鈕的 disabled 狀態限制——
                // 空白名字讓 core 拒絕、就地顯示它的錯誤訊息（A5），而不是靠前端
                // 自己另編一句。
                if (event.key === "Enter") void handleSave();
                if (event.key === "Escape") cancelSaving();
              }}
            />
            <button type="button" disabled={newName.trim().length === 0 || saving} onClick={() => void handleSave()}>
              確定
            </button>
            <button type="button" onClick={cancelSaving}>
              取消
            </button>
            {saveError && (
              <div role="alert" className="template-dialog-error">
                {saveError}
              </div>
            )}
          </div>
        ) : (
          <button type="button" className="template-dialog-save-open" disabled={!canSaveCurrent} onClick={openSaving}>
            把目前這頁存成範本
          </button>
        )}

        {templates.length === 0 ? (
          <p className="template-dialog-empty">還沒有任何範本。可以把目前這頁存成範本。</p>
        ) : (
          <ul className="template-dialog-list">
            {templates.map((template) => (
              <li key={template.file} className="template-dialog-item">
                <iframe
                  className="template-dialog-thumb"
                  sandbox=""
                  title={template.name}
                  srcDoc={thumbnails[template.file] ?? ""}
                />
                {renamingFile === template.file ? (
                  <div className="template-dialog-rename">
                    <input
                      type="text"
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleRenameConfirm(template.file);
                        if (event.key === "Escape") cancelRename();
                      }}
                    />
                    <button type="button" onClick={() => void handleRenameConfirm(template.file)}>
                      確定
                    </button>
                    <button type="button" onClick={cancelRename}>
                      取消
                    </button>
                    {renameError && (
                      <div role="alert" className="template-dialog-error">
                        {renameError}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <span className="template-dialog-name">{template.name}</span>
                    <button type="button" onClick={() => startRename(template)}>
                      改名
                    </button>
                  </>
                )}
                {confirmingDeleteFile === template.file ? (
                  <div className="template-dialog-confirm-delete">
                    <p>刪除後，已用此範本建立的投影片不受影響。</p>
                    <button type="button" onClick={() => void handleDeleteConfirm(template.file)}>
                      確定刪除
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDeleteFile(null);
                        setDeleteError(null);
                      }}
                    >
                      取消
                    </button>
                    {deleteError && (
                      <div role="alert" className="template-dialog-error">
                        {deleteError}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmingDeleteFile(template.file);
                      setDeleteError(null);
                    }}
                  >
                    刪除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
