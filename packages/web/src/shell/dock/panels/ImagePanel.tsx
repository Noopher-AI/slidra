export interface ImagePanelProps {
  onClose(): void;
}

/** Image 插入面板（空容器）。見 TextPanel.tsx 同樣的範圍說明。 */
export function ImagePanel(_props: ImagePanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Image" />;
}
