// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../icons/index.js";
import { useCloseFloatingLayer } from "./use-floating-layer.js";
import { NewMenu } from "./rail/NewMenu.js";
import { TemplatesMenu } from "./rail/TemplatesMenu.js";
import { ThumbContextMenu } from "./rail/ThumbContextMenu.js";
import { OutlineModal } from "./rail/OutlineModal.js";
import { SaveTemplateModal } from "./rail/SaveTemplateModal.js";
import type { TemplateEntry } from "./rail/useTemplateList.js";
import { MasterModeBar } from "./master-mode/MasterModeBar.js";
import { useTemplateAvailability } from "./master-mode/useTemplateAvailability.js";

type CommandResult = { ok: boolean; message: string; data?: unknown };
type RunCommand = (name: string, input: Record<string, unknown>) => Promise<CommandResult | undefined>;
type RunPageCommand = (name: string, input: Record<string, unknown>, targetIndex: number | null) => Promise<CommandResult | undefined>;

export interface ThumbContextMenuRequest {
  index: number;
  x: number;
  y: number;
}

export interface RailProps {
  /** Container overview.ts mounts into. App mounts it once; React never renders its contents (ADR-0001/0002). */
  containerRef: RefObject<HTMLElement | null>;
  /** Slide count shown to the right of the "Slides" heading (template: `SLIDES 7`). */
  slideCount: number;
  /** project.json's slide order — the context menu's Duplicate/Move/Delete need the target slide's virtual path. */
  slides: readonly string[];
  currentIndex: number;
  runCommand: RunCommand;
  runPageCommand: RunPageCommand;
  /** overview.ts's thumbnail context-menu event, mounted in App.tsx (see its own mountOverview hooks comment). */
  contextMenuRequest: ThumbContextMenuRequest | null;
  onCloseContextMenu: () => void;
  /** `OutlineModal`'s "Draft with agent" — sends the raw outline text; App.tsx assembles the fixed prefix and sends it as a chat message. */
  onDraftWithAgent: (outline: string) => void;
  /** `CanvasState.pageSource` — `"templates"` while master mode (`.dev_docs/adr/0013-templates-not-masters.md`) is active; `slides`/`currentIndex` above index the template list in that case. */
  pageSource: "slides" | "templates";
  /** Agent holds the editing lock — disables entering/leaving master mode and its dispatch action, same gate `App.tsx`'s Save/undo/redo already use. */
  editingFrozen: boolean;
  onEnterMasterMode: () => void;
  onExitMasterMode: () => void;
  /** "Let the agent update the slides" (AC3) — App.tsx saves then dispatches. */
  onApplyTemplateToSlides: (templateName: string | null) => void;
}

type RailMenu = "new" | "templates" | null;

/**
 * The left column: New/Templates buttons + the thumbnail rail.
 * `overview.ts` (the existing vanilla DOM module) keeps mounting inside the
 * `.overview` node, and its class names are deliberately kept as-is.
 *
 * The New/Templates/thumbnail-context-menu floating layers are mutually
 * exclusive (02-DESIGN_DOC.md §4.3): opening any one closes the others,
 * always via the existing `useCloseFloatingLayer`, never a second
 * outside-click implementation.
 */
export function Rail({
  containerRef,
  slideCount,
  slides,
  currentIndex,
  runCommand,
  runPageCommand,
  contextMenuRequest,
  onCloseContextMenu,
  onDraftWithAgent,
  pageSource,
  editingFrozen,
  onEnterMasterMode,
  onExitMasterMode,
  onApplyTemplateToSlides,
}: RailProps) {
  const [menu, setMenu] = useState<RailMenu>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  // Bumped after a successful "Save as template" — forces
  // useTemplateAvailability's one caller-controlled refetch, since the very
  // first template a deck ever gets is created through that flow.
  const [templatesEpoch, setTemplatesEpoch] = useState(0);
  const hasTemplates = useTemplateAvailability(runCommand, templatesEpoch);
  const [saveTemplateIndex, setSaveTemplateIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const templatesButtonRef = useRef<HTMLButtonElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useCloseFloatingLayer(menu !== null, [menuRef, newButtonRef, templatesButtonRef], () => setMenu(null));
  useCloseFloatingLayer(contextMenuRequest !== null, [contextMenuRef], onCloseContextMenu);

  // Floating layers are mutually exclusive (02-DESIGN_DOC.md §4.3): opening the thumbnail context menu closes New/Templates too.
  useEffect(() => {
    if (contextMenuRequest !== null) setMenu(null);
  }, [contextMenuRequest]);

  const hasSlides = slideCount > 0;
  const insertAt = hasSlides ? currentIndex + 1 : 0;

  function openMenu(next: Exclude<RailMenu, null>): void {
    onCloseContextMenu();
    setMenu((current) => (current === next ? null : next));
  }

  function addSlideAt(at: number, templatePath?: string): void {
    const input: Record<string, unknown> = { at };
    if (templatePath) input.templatePath = templatePath;
    void runPageCommand("slide add", input, at);
  }

  function onSelectBlank(): void {
    addSlideAt(insertAt);
    setMenu(null);
  }

  function onSelectTemplate(entry: TemplateEntry): void {
    addSlideAt(insertAt, entry.file);
    setMenu(null);
  }

  function onOpenOutline(): void {
    setMenu(null);
    onCloseContextMenu();
    setOutlineOpen(true);
  }

  /** `SaveTemplateModal`'s "Save" — unlike the `addSlideAt` family, this doesn't change page order or currentIndex, so it goes through `runCommand` (not `runPageCommand`), with no reload/showSlide. The modal only closes on success; on failure the input stays, letting the existing `CanvasState.error` banner show the reason (the same existing pattern `runCommand` uses for other Ribbon write failures). */
  async function onSaveTemplateSubmit(name: string): Promise<void> {
    if (saveTemplateIndex === null) return;
    const result = await runCommand("template add", { from: slides[saveTemplateIndex], name });
    if (result?.ok) {
      setSaveTemplateIndex(null);
      setTemplatesEpoch((epoch) => epoch + 1);
    }
  }

  function contextMenuHandlers(index: number) {
    return {
      onNewBelow: () => {
        addSlideAt(index + 1);
        onCloseContextMenu();
      },
      onOutline: () => {
        onCloseContextMenu();
        setOutlineOpen(true);
      },
      onDuplicate: () => {
        void runPageCommand("slide duplicate", { slidePath: slides[index] }, index + 1);
        onCloseContextMenu();
      },
      onSaveAsTemplate: () => {
        onCloseContextMenu();
        setSaveTemplateIndex(index);
      },
      onMoveUp: () => {
        if (index === 0) return;
        void runPageCommand("slide move", { slidePath: slides[index], newIndex: index - 1 }, index - 1);
        onCloseContextMenu();
      },
      onMoveDown: () => {
        if (index === slideCount - 1) return;
        void runPageCommand("slide move", { slidePath: slides[index], newIndex: index + 1 }, index + 1);
        onCloseContextMenu();
      },
      onDelete: () => {
        const newLength = slideCount - 1;
        void runPageCommand("slide delete", { slidePath: slides[index] }, newLength === 0 ? null : Math.min(index, newLength - 1));
        onCloseContextMenu();
      },
    };
  }

  const inMasterMode = pageSource === "templates";

  return (
    <aside className="rail">
      {!inMasterMode && (
        <div className="rail-actions">
          <button
            ref={newButtonRef}
            type="button"
            className="rail-action-button"
            aria-expanded={menu === "new"}
            onClick={() => openMenu("new")}
          >
            <Icon name="plus" size="inline" />
            New
          </button>
          <button
            ref={templatesButtonRef}
            type="button"
            className="rail-action-button"
            aria-expanded={menu === "templates"}
            onClick={() => openMenu("templates")}
          >
            <Icon name="template" size="inline" />
            Templates
          </button>
          {menu === "new" && (
            <NewMenu
              menuRef={menuRef}
              runCommand={runCommand}
              onSelectBlank={onSelectBlank}
              onSelectTemplate={onSelectTemplate}
              onOpenOutline={onOpenOutline}
            />
          )}
          {menu === "templates" && (
            <TemplatesMenu menuRef={menuRef} runCommand={runCommand} onSelectTemplate={onSelectTemplate} />
          )}
        </div>
      )}
      {/* A full-width row of its own, not a third `.rail-actions` item —
          "New"/"Templates" already fill that row's width at two, and a
          third (longer) label there overflows the rail's fixed width
          straight into the stage (verified: the button's own bounding box
          extended past `.rail`'s right edge, so clicks landed on
          `.canvas-area` instead). */}
      <button
        type="button"
        className="rail-master-toggle"
        aria-pressed={inMasterMode}
        disabled={editingFrozen || (!inMasterMode && !hasTemplates)}
        title={!inMasterMode && !hasTemplates ? "Save a slide as a template first" : undefined}
        onClick={inMasterMode ? onExitMasterMode : onEnterMasterMode}
      >
        <Icon name="template" size="inline" />
        {inMasterMode ? "Back to slides" : "Edit template"}
      </button>
      {/* tabIndex=-1: excluded from the Tab sequence, but a click still
          makes it document.activeElement, letting App.tsx's keyboard
          Delete/⌘D handler use `activeElement.closest(".rail")` to
          determine that focus is genuinely inside the rail. */}
      <div className="rail-slides-label" tabIndex={-1}>
        {inMasterMode ? "Templates" : "Slides"}
        <span className="rail-slides-count">{slideCount}</span>
      </div>
      {inMasterMode && (
        <MasterModeBar
          runCommand={runCommand}
          currentTemplatePath={currentIndex >= 0 ? (slides[currentIndex] ?? null) : null}
          disabled={editingFrozen}
          onApply={onApplyTemplateToSlides}
        />
      )}
      <aside className="overview" ref={containerRef} />
      {contextMenuRequest && !inMasterMode && (
        <ThumbContextMenu
          menuRef={contextMenuRef}
          x={contextMenuRequest.x}
          y={contextMenuRequest.y}
          index={contextMenuRequest.index}
          slideCount={slideCount}
          {...contextMenuHandlers(contextMenuRequest.index)}
        />
      )}
      {outlineOpen && (
        <OutlineModal
          onClose={() => setOutlineOpen(false)}
          onSubmit={(outline) => {
            setOutlineOpen(false);
            onDraftWithAgent(outline);
          }}
        />
      )}
      {saveTemplateIndex !== null && (
        <SaveTemplateModal onClose={() => setSaveTemplateIndex(null)} onSubmit={onSaveTemplateSubmit} />
      )}
    </aside>
  );
}
