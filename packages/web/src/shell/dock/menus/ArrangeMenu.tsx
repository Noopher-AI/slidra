export interface ArrangeMenuProps {
  onClose(): void;
}

/**
 * Arrange 選單（空容器）：Align/Distribute/Order 三欄內容是未來票的範圍
 * （見 ShapeMenu.tsx 同樣的說明）。這張骨架票只保證開關與互斥正確。
 */
export function ArrangeMenu(_props: ArrangeMenuProps) {
  return <div className="floating-layer dock-menu" role="menu" aria-label="Arrange" />;
}
