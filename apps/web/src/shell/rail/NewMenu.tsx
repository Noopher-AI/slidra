import type { RefObject } from "react";
import { useTemplateList, type TemplateEntry } from "./useTemplateList.js";

export interface NewMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  runCommand: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message: string; data?: unknown } | undefined>;
  onSelectBlank: () => void;
  onSelectTemplate: (entry: TemplateEntry) => void;
  onOpenOutline: () => void;
}

/**
 * The New panel: `From outline…` + `Layouts` (Blank + the template list).
 * `From outline…` only opens `OutlineModal` and doesn't send any command
 * itself; templates only get applied, with no Rename/Delete. The ⌘N hint
 * text is deliberately not printed.
 */
export function NewMenu({ menuRef, runCommand, onSelectBlank, onSelectTemplate, onOpenOutline }: NewMenuProps) {
  const templateList = useTemplateList(runCommand);

  return (
    <div ref={menuRef} className="rail-menu" role="menu" data-menu="new">
      <button type="button" role="menuitem" className="rail-menu-item" onClick={onOpenOutline}>
        From outline…
      </button>
      <div className="rail-menu-divider" />
      <div className="rail-menu-group-label">Layouts</div>
      <button type="button" role="menuitem" className="rail-menu-item" onClick={onSelectBlank}>
        Blank
      </button>
      {templateList.status === "loading" && <div className="rail-menu-hint">Loading templates…</div>}
      {templateList.status === "error" && (
        <div className="rail-menu-hint rail-menu-error" role="alert">
          {templateList.message}
        </div>
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
