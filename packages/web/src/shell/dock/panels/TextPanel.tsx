export interface TextPanelProps {
  onClose(): void;
}

/**
 * Text 插入面板（空容器）。輸入框/樣式預設/對齊等內容是未來票的範圍（見
 * ticket 說明「Insert-panel contents ... explicitly OUT of scope」）——這張
 * 骨架票只保證按 Text 會從 dock 正上方中央長出這個容器，且與其他 Dock 浮層
 * 互斥、Esc／點外面會關掉（邏輯在 Dock.tsx，這裡不重複）。
 */
export function TextPanel(_props: TextPanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Text" />;
}
