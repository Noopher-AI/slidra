export type RibbonTabId = "home" | "insert" | "transitions" | "show";

/** Every ribbon button's stable id (19 total); T2–T7 add one handler entry per id. */
export type RibbonCmdId =
  | "new-slide"
  | "template"
  | "paste"
  | "cut"
  | "copy"
  | "textbox"
  | "shape"
  | "arrange"
  | "insert-image"
  | "insert-video"
  | "insert-audio"
  | "insert-shape"
  | "insert-textbox"
  | "slide-number"
  | "transition-none"
  | "transition-fade"
  | "play-from-start"
  | "play-from-current"
  | "toggle-fullscreen";

export interface RibbonCmd {
  id: RibbonCmdId;
  label: string;
  icon: string;
}

export interface RibbonGroup {
  label: string;
  cmds: RibbonCmd[];
}

export const TABS: { id: RibbonTabId; label: string }[] = [
  { id: "home", label: "常用" },
  { id: "insert", label: "插入" },
  { id: "transitions", label: "切換" },
  { id: "show", label: "投影片放映" },
];

export const RIBBON: Record<RibbonTabId, RibbonGroup[]> = {
  home: [
    {
      label: "投影片",
      cmds: [
        { id: "new-slide", label: "新增投影片", icon: "plus" },
        { id: "template", label: "範本", icon: "template" },
      ],
    },
    {
      label: "剪貼簿",
      cmds: [
        { id: "paste", label: "貼上", icon: "paste" },
        { id: "cut", label: "剪下", icon: "cut" },
        { id: "copy", label: "複製", icon: "copy" },
      ],
    },
    {
      label: "繪圖",
      cmds: [
        { id: "textbox", label: "文字方塊", icon: "textbox" },
        { id: "shape", label: "圖案", icon: "shape" },
        { id: "arrange", label: "排列", icon: "arrange" },
      ],
    },
  ],
  insert: [
    {
      label: "媒體",
      cmds: [
        { id: "insert-image", label: "圖片", icon: "image" },
        { id: "insert-video", label: "影片", icon: "video" },
        { id: "insert-audio", label: "音訊", icon: "audio" },
      ],
    },
    { label: "內容", cmds: [{ id: "insert-shape", label: "圖案", icon: "shape" }] },
    {
      label: "文字",
      cmds: [
        { id: "insert-textbox", label: "文字方塊", icon: "textbox" },
        { id: "slide-number", label: "頁碼", icon: "number" },
      ],
    },
  ],
  transitions: [
    {
      label: "切換效果",
      cmds: [
        { id: "transition-none", label: "無", icon: "none" },
        { id: "transition-fade", label: "淡入淡出", icon: "fade" },
      ],
    },
  ],
  show: [
    {
      label: "開始放映",
      cmds: [
        { id: "play-from-start", label: "從頭播放", icon: "fromstart" },
        { id: "play-from-current", label: "從目前投影片", icon: "fromhere" },
        { id: "toggle-fullscreen", label: "全螢幕", icon: "fullscr" },
      ],
    },
  ],
};

/** cmd id → handler. Missing key or `undefined` value both fall through to the not-implemented placeholder. */
export type RibbonHandlers = Partial<Record<RibbonCmdId, () => void>>;
