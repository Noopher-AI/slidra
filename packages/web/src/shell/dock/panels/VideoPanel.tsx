export interface VideoPanelProps {
  onClose(): void;
}

/** Video 插入面板（空容器）。見 TextPanel.tsx 同樣的範圍說明。 */
export function VideoPanel(_props: VideoPanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Video" />;
}
