// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useRef, useState } from "react";
import type { CanvasController, CanvasSelection } from "../../canvas.js";
import { Icon, type IconName } from "../../icons/index.js";
import type { HandState, ZoomPanState } from "../stage-view.js";
import { useCloseFloatingLayer } from "../use-floating-layer.js";
import { HandButton } from "./HandButton.js";
import { ZoomControl } from "./ZoomControl.js";
import { ZoomMenu } from "./menus/ZoomMenu.js";
import { ShapeMenu } from "./menus/ShapeMenu.js";
import { ArrangeMenu } from "./menus/ArrangeMenu.js";
import { TextPanel } from "./panels/TextPanel.js";
import { ImagePanel } from "./panels/ImagePanel.js";
import { VideoPanel } from "./panels/VideoPanel.js";
import { AudioPanel } from "./panels/AudioPanel.js";
import { TablePanel } from "./panels/TablePanel.js";
import { ChartPanel } from "./panels/ChartPanel.js";
import { AnimatePanel } from "./panels/AnimatePanel.js";

/**
 * Every floating layer the dock can open. `"zoom"` is the one fully wired
 * behaviour that ticket shipped (see ZoomMenu.tsx); every insert panel and
 * the shape/arrange menus are empty containers — their contents are a
 * future ticket (see the PR report). There is no `"group"` entry: Group/
 * Ungroup is not a floating layer — it sends `element
 * group`/`element ungroup` straight through `controller.runCommand` and
 * shows a toast, it never opens anything under `openLayer`.
 */
export type DockLayer = "zoom" | "shape" | "arrange" | "text" | "image" | "video" | "audio" | "table" | "chart" | "animate";

export interface DockProps {
  zoomPan: ZoomPanState;
  onZoomPanChange(next: ZoomPanState): void;
  hand: HandState;
  onToggleHand(): void;
  selection: CanvasSelection;
  controller: CanvasController | null;
  /** The `effect add` sent by Add animation needs the current slide's path; it's null when there is no slide. */
  slidePath: string | null;
  /** Switches the right column to Animate › Object after Add animation succeeds (per the GUI behaviour table). */
  onAnimationAdded(): void;
  /** The presentation's own canvas size (project.json's `canvas`) — TextPanel converts the prototype's percentage-based defaults into real pixels against it, instead of assuming 1280×720. `null` before `presentationInfo` has loaded. */
  canvasSize: { width: number; height: number } | null;
  /** ShapeMenu's rect/ellipse fill, line stroke, and TextPanel's text fill all default to the current slide's own accent colour when set. Without an accent, all three compute a contrast colour off `pageStyle.background` instead (`contrast-fill.ts`) — never omitted, never a design-token fallback. `null` before a slide has loaded, or when the slide declares no page style at all, reaches that computation as a `null` background. */
  pageStyle: { background: string | null; accent: string | null } | null;
}

interface CommandDef {
  key: DockLayer;
  label: string;
  icon: IconName;
}

const INSERT_COMMANDS: CommandDef[] = [
  { key: "text", label: "Text", icon: "textbox" },
  { key: "shape", label: "Shape", icon: "shape" },
  { key: "image", label: "Image", icon: "image" },
  { key: "video", label: "Video", icon: "video" },
  { key: "audio", label: "Audio", icon: "audio" },
  { key: "table", label: "Table", icon: "table" },
  { key: "chart", label: "Chart", icon: "chart" },
];

const EDIT_COMMANDS: CommandDef[] = [
  { key: "animate", label: "Animate", icon: "spark" },
  { key: "arrange", label: "Arrange", icon: "arrange" },
];

/** Disabled state: Animate/Arrange are dimmed and unclickable without a selection; the Insert group is unaffected by selection. */
function isCommandDisabled(key: DockLayer, hasSelection: boolean): boolean {
  return (key === "animate" || key === "arrange") && !hasSelection;
}

export interface GroupButtonState {
  label: "Group" | "Ungroup";
  disabled: boolean;
}

/**
 * D5: Group/Ungroup is one button that flips label by what's selected
 * (03-UI_RATIONALE.md §D). The disabled state requires ≥2
 * elements, or exactly one group, to enable it; a `null` entry in
 * `selection.elements` (a reload racing the selection) is treated as "not
 * a group", never as a group.
 */
export function computeGroupButtonState(
  selection: CanvasSelection,
  controller: CanvasController | null,
  slidePath: string | null,
  pending: boolean,
): GroupButtonState {
  const n = selection.ids.length;
  const isGroupSelected = n === 1 && selection.elements[0]?.kind === "group";
  const label: GroupButtonState["label"] = isGroupSelected ? "Ungroup" : "Group";
  const disabled = pending || controller === null || slidePath === null || n === 0 || (n === 1 && !isGroupSelected);
  return { label, disabled };
}

/** D3/D4: toast text, copied verbatim from the prototype (docs/design/prototype/slidra-logic-v3.js:192-193). */
export function groupToastText(action: "group" | "ungroup", n: number, removedEffects: number): string {
  if (action === "group") {
    return removedEffects > 0 ? `Grouped ${n} elements · their animations were removed` : `Grouped ${n} elements`;
  }
  return removedEffects > 0 ? "Ungrouped · the group animation was removed" : "Ungrouped";
}

const TOAST_DURATION_MS = 2500;

/** D3: lives inside `.dock`, not a global toast service — see Dock's own comment on why. */
export function DockToast({ text }: { text: string }) {
  return (
    <div role="status" className="dock-toast">
      {text}
    </div>
  );
}

/**
 * The bottom glass toolbar (New v3 skeleton). Three sections, left/center/right:
 * hand + zoom (left), Insert group (center), Edit group (right). The mutual-
 * exclusion rule (02-DESIGN_DOC.md §4.3) falls out naturally from a single
 * `openLayer` state: opening one layer just sets the state to a different
 * value, no extra coordination needed. Whichever layer is currently open is
 * always rendered as a direct child of `.dock` (never nested inside its own
 * button cell), so `.floating-layer`'s absolute positioning centers against
 * the whole dock, not against the button that triggered it (per
 * 02-DESIGN_DOC.md §2.3: "always grows from the same place").
 */
export function Dock({
  zoomPan,
  onZoomPanChange,
  hand,
  onToggleHand,
  selection,
  controller,
  slidePath,
  onAnimationAdded,
  canvasSize,
  pageStyle,
}: DockProps) {
  const [openLayer, setOpenLayer] = useState<DockLayer | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const hasSelection = selection.ids.length > 0;

  const [toast, setToast] = useState<string | null>(null);
  const [groupPending, setGroupPending] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useCloseFloatingLayer(openLayer !== null, [dockRef], () => setOpenLayer(null));

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  function toggle(key: DockLayer): void {
    setOpenLayer((current) => (current === key ? null : key));
  }

  function showToast(text: string): void {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }

  const groupButton = computeGroupButtonState(selection, controller, slidePath, groupPending);

  /** D1/D2/D3: sends `element group`/`element ungroup` straight through `runCommand`, then toasts off its `removedEffects`. A failure surfaces through the existing `CanvasState.error` channel — no toast for it (4.3). */
  async function handleGroupCommand(): Promise<void> {
    if (groupButton.disabled || controller === null || slidePath === null) return;
    const action = groupButton.label === "Ungroup" ? "ungroup" : "group";
    const n = selection.ids.length;
    setGroupPending(true);
    const result = await controller.runCommand(action === "group" ? "element group" : "element ungroup", {
      slidePath,
      elementIds: [...selection.ids],
    });
    setGroupPending(false);
    if (!result.ok) return;
    const data = result.data as { removedEffects?: unknown } | undefined;
    const removedEffects = typeof data?.removedEffects === "number" ? data.removedEffects : 0;
    showToast(groupToastText(action, n, removedEffects));
  }

  function renderCommand(cmd: CommandDef) {
    return (
      <button
        key={cmd.key}
        type="button"
        className="dock-command"
        title={cmd.label}
        aria-label={cmd.label}
        aria-expanded={openLayer === cmd.key}
        disabled={isCommandDisabled(cmd.key, hasSelection)}
        onClick={() => toggle(cmd.key)}
      >
        <Icon name={cmd.icon} size="command" />
        <span>{cmd.label}</span>
      </button>
    );
  }

  function renderOpenLayer() {
    const onClose = () => setOpenLayer(null);
    switch (openLayer) {
      case "zoom":
        return <ZoomMenu zoomPan={zoomPan} onChange={onZoomPanChange} onClose={onClose} />;
      case "shape":
        return (
          <ShapeMenu
            onClose={onClose}
            controller={controller}
            canvasSize={canvasSize}
            slidePath={slidePath}
            pageStyle={pageStyle}
          />
        );
      case "arrange":
        return <ArrangeMenu selection={selection} controller={controller} onClose={onClose} />;
      case "text":
        return <TextPanel onClose={onClose} controller={controller} canvasSize={canvasSize} pageStyle={pageStyle} />;
      case "image":
        return <ImagePanel onClose={onClose} controller={controller} canvasSize={canvasSize} slidePath={slidePath} />;
      case "video":
        return <VideoPanel onClose={onClose} controller={controller} canvasSize={canvasSize} slidePath={slidePath} />;
      case "audio":
        return <AudioPanel onClose={onClose} controller={controller} canvasSize={canvasSize} slidePath={slidePath} />;
      case "table":
        return <TablePanel onClose={onClose} controller={controller} canvasSize={canvasSize} slidePath={slidePath} />;
      case "chart":
        return <ChartPanel onClose={onClose} controller={controller} slidePath={slidePath} />;
      case "animate":
        return (
          <AnimatePanel
            selection={selection}
            controller={controller}
            slidePath={slidePath}
            onAdded={onAnimationAdded}
            onClose={onClose}
          />
        );
      default:
        return null;
    }
  }

  return (
    <div className="dock" ref={dockRef} data-open-layer={openLayer ?? undefined}>
      <div className="dock-left">
        <HandButton active={hand.hand} onToggle={onToggleHand} />
        <ZoomControl zoom={zoomPan.zoom} open={openLayer === "zoom"} onToggle={() => toggle("zoom")} />
      </div>
      <span className="dock-divider" />
      <div className="dock-center">{INSERT_COMMANDS.map(renderCommand)}</div>
      {/* No divider between the Insert and Edit groups (03-UI_RATIONALE.md §D: the three right-side items skip the divider to signal they're the same kind; the prototype only draws one after hand/zoom). */}
      <div className="dock-right">
        {EDIT_COMMANDS.map(renderCommand)}
        <button
          type="button"
          className="dock-command"
          title={groupButton.label}
          aria-label={groupButton.label}
          disabled={groupButton.disabled}
          onClick={() => void handleGroupCommand()}
        >
          <Icon name="group" size="command" />
          <span>{groupButton.label}</span>
        </button>
      </div>
      {openLayer !== null && renderOpenLayer()}
      {toast !== null && <DockToast text={toast} />}
    </div>
  );
}
