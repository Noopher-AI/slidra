export interface ShapeMenuProps {
  onClose(): void;
}

/**
 * Shape 選單（空容器）：05-INTERACTIONS.feature 的 Rectangle/Ellipse/Line
 * 三個選項是插入功能本身，跟 Insert 面板的內容一樣是未來票的範圍——這張
 * 骨架票只保證「按 Shape 會從 dock 正上方中央長出這個容器、Esc／點外面會
 * 關掉」（見 Dock.tsx 的互斥/關閉邏輯），容器裡不渲染任何東西。
 */
export function ShapeMenu(_props: ShapeMenuProps) {
  return <div className="floating-layer dock-menu" role="menu" aria-label="Shape" />;
}
