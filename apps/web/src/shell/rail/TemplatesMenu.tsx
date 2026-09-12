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
 * The Templates button: an apply-only template list, not the template's
 * management dialog (Rename/Delete are not wired up). Clicking a template
 * calls the exact same `onSelectTemplate` as the identically named item in
 * the New panel's Layouts group — the caller (Rail.tsx) uses the same
 * function.
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
