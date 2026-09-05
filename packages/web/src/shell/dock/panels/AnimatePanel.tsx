export interface AnimatePanelProps {
  onClose(): void;
}

/**
 * Animate 插入面板（空容器，工具列的 Animate 命令用）。效果卡／Start／
 * Duration 等內容是未來票的範圍——見 side/AnimateObjectPanel.tsx 的說明：
 * 右欄的 Animate › Object 分頁是「新增之後」查看/編輯已加動畫的地方，這裡
 * 則是「新增」動畫的入口，兩者都是空容器，各自獨立、不互相代管。
 */
export function AnimatePanel(_props: AnimatePanelProps) {
  return <div className="floating-layer dock-panel" role="dialog" aria-label="Animate" />;
}
