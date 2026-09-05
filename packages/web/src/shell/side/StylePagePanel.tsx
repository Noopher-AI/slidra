/**
 * 樣式 › Page（空容器）。頁面層級的樣式設定內容是未來票的範圍——這張骨架
 * 票只保證 SidePanel.tsx 的 side/sub 狀態機正確地把這個分頁掛上/卸下。
 */
export function StylePagePanel() {
  return <div className="style-page-panel" role="tabpanel" aria-label="Style · Page" />;
}
