export interface TablePanelProps {
  onClose(): void;
}

/** Table 插入面板（空容器）。見 TextPanel.tsx 同樣的範圍說明。 */
export function TablePanel(_props: TablePanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Table" />;
}
