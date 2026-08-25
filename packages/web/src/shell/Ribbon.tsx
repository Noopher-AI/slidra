import { useState } from "react";

// Icons are hand-drawn in this repo (traced from docs/design/base-shell.html); no third-party icon art.

export interface RibbonProps {
  /** 從頭播放：showSlide(0) 後 play()。 */
  onPlayFromStart(): void;
  /** 從目前投影片：直接 play()。 */
  onPlayFromCurrent(): void;
  /** 全螢幕：與 PlayChrome 上那顆共用 App 的 toggleFullscreen（含 #29 的競態修正）。 */
  onToggleFullscreen(): void;
  /** slides 為空時，這三顆唯一活著的鈕也必須 disabled——沒有東西可播。 */
  canPlay: boolean;
}

type RibbonTabId = "home" | "insert" | "transitions" | "show";

/** SVG path fragments (viewBox 0 0 20 20), traced from base-shell.html's `const I`. */
const ICON: Record<string, string> = {
  plus: '<path d="M10 4v12M4 10h12"/>',
  layout: '<rect x="2.5" y="3.5" width="15" height="13"/><path d="M2.5 8h15M10 8v8.5"/>',
  paste: '<rect x="5" y="3" width="10" height="14"/><path d="M8 3V1.5h4V3"/>',
  cut: '<circle cx="5" cy="15" r="2"/><circle cx="15" cy="15" r="2"/><path d="M6 13.5L14 3M14 13.5L6 3"/>',
  copy: '<rect x="3" y="3" width="9" height="11"/><path d="M6 16h8V6"/>',
  textbox: '<rect x="2.5" y="5" width="15" height="10"/><path d="M7 8h6M10 8v4"/>',
  shape: '<circle cx="7" cy="7" r="4.5"/><rect x="8" y="9" width="8" height="8"/>',
  arrange: '<rect x="2.5" y="2.5" width="9" height="9"/><rect x="8" y="8" width="9" height="9"/>',
  image: '<rect x="2.5" y="3.5" width="15" height="13"/><circle cx="7" cy="8" r="1.5"/><path d="M3 15l5-5 4 4 2-2 3 3"/>',
  video: '<rect x="2.5" y="4.5" width="10" height="11"/><path d="M13 8l4.5-2.5v9L13 12z"/>',
  audio: '<path d="M4 8v4h3l4 3.5V4.5L7 8z"/><path d="M13.5 7.5a4 4 0 010 5"/>',
  table: '<rect x="2.5" y="3.5" width="15" height="13"/><path d="M2.5 8h15M2.5 12h15M7.5 3.5v13M12.5 3.5v13"/>',
  chart: '<path d="M3 17V3"/><path d="M3 17h14"/><rect x="6" y="10" width="3" height="7"/><rect x="11" y="6" width="3" height="11"/>',
  number: '<rect x="2.5" y="3.5" width="15" height="13"/><path d="M12 14h3"/>',
  none: '<circle cx="10" cy="10" r="7"/><path d="M5 15L15 5"/>',
  fade: '<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 010 14z" fill="currentColor" stroke="none" opacity=".5"/>',
  push: '<rect x="2.5" y="4.5" width="15" height="11"/><path d="M7 10h6M11 7l3 3-3 3"/>',
  wipe: '<rect x="2.5" y="4.5" width="15" height="11"/><path d="M10 4.5v11"/>',
  split: '<rect x="2.5" y="4.5" width="6" height="11"/><rect x="11.5" y="4.5" width="6" height="11"/>',
  effopt: '<circle cx="10" cy="10" r="3"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3"/>',
  applyall: '<path d="M3 10l4 4 10-10"/>',
  fromstart: '<path d="M6 4l9 6-9 6z"/><path d="M3 4v12"/>',
  fromhere: '<path d="M5 4l9 6-9 6z"/>',
  fullscr: '<path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"/>',
  timer: '<circle cx="10" cy="11" r="6"/><path d="M10 8v3l2 2M8 2h4"/>',
  record: '<circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none"/>',
  hide: '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><path d="M3 3l14 14"/>',
  custom: '<rect x="2.5" y="3.5" width="15" height="13"/><path d="M6 7h8M6 10h8M6 13h5"/>',
  setup: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.5 1.5M14 14l1.5 1.5M15.5 4.5L14 6M6 14l-1.5 1.5"/>',
};

interface RibbonCmd {
  label: string;
  icon: string;
  /** Only these three are wired to a real handler; everything else stays genuinely disabled. */
  live?: "from-start" | "from-current" | "fullscreen";
}

interface RibbonGroup {
  label: string;
  cmds: RibbonCmd[];
}

const TABS: { id: RibbonTabId; label: string }[] = [
  { id: "home", label: "常用" },
  { id: "insert", label: "插入" },
  { id: "transitions", label: "切換" },
  { id: "show", label: "投影片放映" },
];

const RIBBON: Record<RibbonTabId, RibbonGroup[]> = {
  home: [
    { label: "投影片", cmds: [{ label: "新增投影片", icon: "plus" }, { label: "版面配置", icon: "layout" }] },
    { label: "剪貼簿", cmds: [{ label: "貼上", icon: "paste" }, { label: "剪下", icon: "cut" }, { label: "複製", icon: "copy" }] },
    { label: "繪圖", cmds: [{ label: "文字方塊", icon: "textbox" }, { label: "圖案", icon: "shape" }, { label: "排列", icon: "arrange" }] },
  ],
  insert: [
    { label: "媒體", cmds: [{ label: "圖片", icon: "image" }, { label: "影片", icon: "video" }, { label: "音訊", icon: "audio" }] },
    { label: "內容", cmds: [{ label: "表格", icon: "table" }, { label: "圖表", icon: "chart" }, { label: "圖案", icon: "shape" }] },
    { label: "文字", cmds: [{ label: "文字方塊", icon: "textbox" }, { label: "頁碼", icon: "number" }] },
  ],
  transitions: [
    {
      label: "切換效果",
      cmds: [
        { label: "無", icon: "none" },
        { label: "淡入淡出", icon: "fade" },
        { label: "推移", icon: "push" },
        { label: "擦去", icon: "wipe" },
        { label: "分割", icon: "split" },
      ],
    },
    { label: "計時", cmds: [{ label: "效果選項", icon: "effopt" }, { label: "全部套用", icon: "applyall" }] },
  ],
  show: [
    {
      label: "開始放映",
      cmds: [
        { label: "從頭播放", icon: "fromstart", live: "from-start" },
        { label: "從目前投影片", icon: "fromhere", live: "from-current" },
        { label: "全螢幕", icon: "fullscr", live: "fullscreen" },
      ],
    },
    { label: "設定", cmds: [{ label: "排練計時", icon: "timer" }, { label: "錄製", icon: "record" }, { label: "隱藏投影片", icon: "hide" }] },
    { label: "自訂", cmds: [{ label: "自訂放映", icon: "custom" }, { label: "設定放映方式", icon: "setup" }] },
  ],
};

/**
 * The ribbon (#51). Only the current tab's buttons are rendered — the
 * template's own approach — so the DOM always holds one tab's worth of
 * commands (≤8), not all 31 at once with CSS hiding the rest (that would
 * make "the disabled tab isn't reachable" and the baseline screenshot both
 * sensitive to DOM order instead of what's actually on screen).
 */
export function Ribbon({ onPlayFromStart, onPlayFromCurrent, onToggleFullscreen, canPlay }: RibbonProps) {
  const [tab, setTab] = useState<RibbonTabId>("show");

  function handler(live: RibbonCmd["live"]): (() => void) | undefined {
    if (live === "from-start") return onPlayFromStart;
    if (live === "from-current") return onPlayFromCurrent;
    if (live === "fullscreen") return onToggleFullscreen;
    return undefined;
  }

  return (
    <div className="ribbon">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="groups">
        {RIBBON[tab].map((group) => (
          <div className="group" key={group.label}>
            {group.cmds.map((cmd) => {
              const onClick = handler(cmd.live);
              // Unimplemented (no handler at all) vs. implemented-but-nothing-to-play
              // (canPlay is false) are different reasons to be disabled — only the
              // former is honestly "尚未實作" (#51's acceptance criterion); the latter still
              // says nothing, rather than lying about why the button is greyed out.
              const disabled = !onClick || !canPlay;
              return (
                <button
                  key={cmd.label}
                  type="button"
                  className="cmd"
                  disabled={disabled}
                  title={!onClick ? "尚未實作" : undefined}
                  onClick={onClick && !disabled ? onClick : undefined}
                >
                  <svg viewBox="0 0 20 20" dangerouslySetInnerHTML={{ __html: ICON[cmd.icon] }} />
                  <span>{cmd.label}</span>
                </button>
              );
            })}
            <span className="group-label">{group.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
