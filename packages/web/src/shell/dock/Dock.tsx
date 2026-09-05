import { useRef, useState } from "react";
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
 * behaviour this ticket ships (see ZoomMenu.tsx); every insert panel and the
 * shape/arrange menus are empty containers — their contents are a future
 * ticket (see the PR report). There is no `"group"` entry: 05-INTERACTIONS
 * .feature's Group command has no assigned panel/menu component in this
 * ticket's file list, so this skeleton renders it as a permanently
 * disabled button (see the JSX below) — the prototype's dock ends with
 * `Animate Arrange Group`, and 03-UI_RATIONALE.md §D says the three
 * form one group with no divider between them.
 */
export type DockLayer = "zoom" | "shape" | "arrange" | "text" | "image" | "video" | "audio" | "table" | "chart" | "animate";

export interface DockProps {
  zoomPan: ZoomPanState;
  onZoomPanChange(next: ZoomPanState): void;
  hand: HandState;
  onToggleHand(): void;
  selection: CanvasSelection;
  controller: CanvasController | null;
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

/** 05-INTERACTIONS.feature「停用態」：沒有選取時 Animate/Arrange 半透明不可按；Insert 群組不受選取影響。 */
function isCommandDisabled(key: DockLayer, hasSelection: boolean): boolean {
  return (key === "animate" || key === "arrange") && !hasSelection;
}

/**
 * 底部玻璃工具列 (New v3 skeleton)。left/center/right 三段：✋ + 縮放（left）、
 * Insert 群組（center）、Edit 群組（right）。互斥規則（02-DESIGN_DOC.md §4.3）
 * 用單一 `openLayer` state 天然滿足：開一個就是把 state 設成別的值，不需要
 * 額外協調。目前開啟的那一層一律當 `.dock` 的直接子節點渲染（不巢狀在各自
 * 的按鈕格子裡），這樣 `.floating-layer` 的絕對定位才是相對整個 dock 置中，
 * 不是相對觸發它的那顆按鈕（05-INTERACTIONS.feature「縮放選單」／
 * 02-DESIGN_DOC.md §2.3「一律從同一個地方長出」）。
 */
export function Dock({ zoomPan, onZoomPanChange, hand, onToggleHand, selection, controller }: DockProps) {
  const [openLayer, setOpenLayer] = useState<DockLayer | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const hasSelection = selection.ids.length > 0;

  useCloseFloatingLayer(openLayer !== null, [dockRef], () => setOpenLayer(null));

  function toggle(key: DockLayer): void {
    setOpenLayer((current) => (current === key ? null : key));
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
        return <ShapeMenu onClose={onClose} />;
      case "arrange":
        return <ArrangeMenu selection={selection} controller={controller} onClose={onClose} />;
      case "text":
        return <TextPanel onClose={onClose} />;
      case "image":
        return <ImagePanel onClose={onClose} />;
      case "video":
        return <VideoPanel onClose={onClose} />;
      case "audio":
        return <AudioPanel onClose={onClose} />;
      case "table":
        return <TablePanel onClose={onClose} />;
      case "chart":
        return <ChartPanel onClose={onClose} />;
      case "animate":
        return <AnimatePanel onClose={onClose} />;
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
      {/* Insert 與 Edit 群組之間沒有分隔線（03-UI_RATIONALE.md §D：右段三者「不加分隔線以表示同類」，原型也只在 ✋/縮放後面畫一條）。 */}
      <div className="dock-right">
        {EDIT_COMMANDS.map(renderCommand)}
        {/* 外觀佔位：Group 尚無面板/指令可接（見檔頭註解），一律停用。 */}
        <button type="button" className="dock-command" title="Group" aria-label="Group" disabled>
          <Icon name="group" size="command" />
          <span>Group</span>
        </button>
      </div>
      {openLayer !== null && renderOpenLayer()}
    </div>
  );
}
