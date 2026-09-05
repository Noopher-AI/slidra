export interface AudioPanelProps {
  onClose(): void;
}

/** Audio 插入面板（空容器）。見 TextPanel.tsx 同樣的範圍說明。 */
export function AudioPanel(_props: AudioPanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Audio" />;
}
