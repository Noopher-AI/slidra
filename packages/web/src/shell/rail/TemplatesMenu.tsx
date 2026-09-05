import type { RefObject } from "react";
import { useTemplateList, type TemplateEntry } from "./useTemplateList.js";

export interface TemplatesMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  runCommand: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;
  onSelectTemplate: (entry: TemplateEntry) => void;
}

/**
 * Templates 按鈕：只套用的範本清單，不是原型的管理對話框（Rename/Delete
 * 不接，T3 plan §7 決定 4）。點某個範本走跟 New 面板 Layouts 群組裡同名項
 * 目完全一樣的 `onSelectTemplate`——呼叫端（Rail.tsx）用同一個函式。
 */
export function TemplatesMenu({ menuRef, runCommand, onSelectTemplate }: TemplatesMenuProps) {
  const templateList = useTemplateList(runCommand);

  return (
    <div ref={menuRef} className="rail-menu" role="menu" data-menu="templates">
      {templateList.status === "loading" && <div className="rail-menu-hint">Loading templates…</div>}
      {templateList.status === "error" && (
        <div className="rail-menu-hint rail-menu-error" role="alert">
          {templateList.message}
        </div>
      )}
      {templateList.status === "ready" && templateList.templates.length === 0 && (
        <div className="rail-menu-hint">No templates yet</div>
      )}
      {templateList.status === "ready" &&
        templateList.templates.map((entry) => (
          <button
            key={entry.file}
            type="button"
            role="menuitem"
            className="rail-menu-item"
            onClick={() => onSelectTemplate(entry)}
          >
            {entry.name}
          </button>
        ))}
    </div>
  );
}
