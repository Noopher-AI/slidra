import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/index.js";
import { RIBBON, TABS, type RibbonCmdId, type RibbonHandlers, type RibbonTabId } from "./ribbon-commands.js";

/** One selectable row inside a ribbon dropdown (新增投影片 / 圖案 / 排列 — NOOP-141). */
export interface RibbonMenuItem {
  key: string;
  label: string;
  onSelect(): void;
}

export interface RibbonMenuGroup {
  /** Omitted for a single-group menu (新增投影片 / 圖案) — only 排列's three groups need one. */
  label?: string;
  items: RibbonMenuItem[];
}

export interface RibbonMenuState {
  /** Which cmd button this popover is anchored under. */
  anchor: RibbonCmdId;
  groups: RibbonMenuGroup[];
}

export interface RibbonProps {
  /** 從頭播放：showSlide(0) 後 play()。 */
  onPlayFromStart(): void;
  /** 從目前投影片：直接 play()。 */
  onPlayFromCurrent(): void;
  /** 全螢幕：與 PlayChrome 上那顆共用 App 的 toggleFullscreen（含 #29 的競態修正）。 */
  onToggleFullscreen(): void;
  /** slides 為空時，這三顆唯一活著的鈕也必須 disabled——沒有東西可播。 */
  canPlay: boolean;
  /** T2's per-cmd handlers (NOOP-141) — merged with the three play/fullscreen handlers above, which keep their own dedicated props. */
  handlers: RibbonHandlers;
  /** The one open dropdown (新增投影片 / 圖案 / 排列), or null. Contents come from App.tsx — it alone has access to `templates`/selection/canvas size — this component only renders and positions it. */
  menu: RibbonMenuState | null;
  onCloseMenu(): void;
}

/** How long the "尚未接上" notice stays before auto-dismissing. */
const NOTICE_DURATION_MS = 2500;

/**
 * The ribbon (#51). Only the current tab's buttons are rendered — the
 * template's own approach — so the DOM always holds one tab's worth of
 * commands (≤8), not all 18 at once with CSS hiding the rest (that would
 * make "the disabled tab isn't reachable" and the baseline screenshot both
 * sensitive to DOM order instead of what's actually on screen).
 */
export function Ribbon({
  onPlayFromStart,
  onPlayFromCurrent,
  onToggleFullscreen,
  canPlay,
  handlers: cmdHandlers,
  menu,
  onCloseMenu,
}: RibbonProps) {
  const [tab, setTab] = useState<RibbonTabId>("show");
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  // Click outside the ribbon, or Esc, closes an open dropdown (behaviour
  // contract row "選單開著時切換分頁 / 點選單外", NOOP-141). Only attached
  // while a menu is actually open, so it never intercepts a stray Esc/click
  // the rest of the app might want.
  useEffect(() => {
    if (!menu) return;
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        onCloseMenu();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onCloseMenu();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, onCloseMenu]);

  function selectTab(id: RibbonTabId): void {
    setTab(id);
    onCloseMenu();
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(null);
  }

  function showNotImplementedNotice(): void {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice("此操作尚未接上");
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
  }

  const handlers: RibbonHandlers = {
    "play-from-start": onPlayFromStart,
    "play-from-current": onPlayFromCurrent,
    "toggle-fullscreen": onToggleFullscreen,
    ...cmdHandlers,
  };

  return (
    <div className="ribbon" ref={rootRef}>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="groups">
        {RIBBON[tab].map((group) => (
          <div className="group" key={group.label}>
            {group.cmds.map((cmd) => {
              const run = handlers[cmd.id];
              // canPlay=false is an honest "nothing to play" disabled, distinct
              // from "尚未實作" — an unwired button stays enabled and shows the
              // placeholder notice on click instead of going disabled (A1).
              const disabled = run ? !canPlay : false;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  className="cmd"
                  disabled={disabled}
                  title={run ? undefined : "尚未實作"}
                  onClick={() => (run ? run() : showNotImplementedNotice())}
                >
                  <Icon name={cmd.icon} size="command" />
                  <span>{cmd.label}</span>
                </button>
              );
            })}
            <span className="group-label">{group.label}</span>
            {menu && group.cmds.some((cmd) => cmd.id === menu.anchor) && (
              <div className="ribbon-menu" role="menu">
                {menu.groups.map((menuGroup, index) => (
                  <div className="ribbon-menu-group" key={menuGroup.label ?? index}>
                    {menuGroup.label && <div className="ribbon-menu-group-label">{menuGroup.label}</div>}
                    {menuGroup.items.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        role="menuitem"
                        className="ribbon-menu-item"
                        onClick={item.onSelect}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {notice && (
        <div className="ribbon-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
