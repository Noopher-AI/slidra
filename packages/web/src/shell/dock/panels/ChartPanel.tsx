export interface ChartPanelProps {
  onClose(): void;
}

/** Chart 插入面板（空容器）。見 TextPanel.tsx 同樣的範圍說明。 */
export function ChartPanel(_props: ChartPanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Chart" />;
}
