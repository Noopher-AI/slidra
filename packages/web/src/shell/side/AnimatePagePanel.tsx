import type { PageTransitionEffect } from "@co-motion/core/slide";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { useSlideTransition } from "./animate/useSlideTransition.js";
import { PageTransitionView } from "./animate/PageTransitionView.js";

export interface AnimatePagePanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/**
 * 動畫 › Page（[E2.T11]/#207 §4.7）：`useSlideTransition` 供資料，每個操作
 * 即時送出 `slide transition set`（D14：一次命令＝一次
 * `writePresentationFile`＝一筆 undo，這裡不寫任何 undo 程式碼）。命令成功後
 * 呼叫 `refresh()` 重新讀檔——不等下一次不相干的 reload() 才看到自己剛做的
 * 改動；失敗時不 `refresh()`、不改 UI（比照 `AnimateObjectPanel`）。
 */
export function AnimatePagePanel({ state, controller }: AnimatePagePanelProps) {
  const { transition, refresh } = useSlideTransition(state);
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;

  if (!slidePath || transition === null) {
    return <div className="animate-page-panel" role="tabpanel" aria-label="動畫 · Page" />;
  }

  async function runTransitionCommand(input: Record<string, unknown>): Promise<void> {
    if (!controller || !slidePath) return;
    const result = await controller.runCommand("slide transition set", { slidePath, ...input });
    if (result.ok) refresh();
  }

  function handleChangeEnterEffect(effect: PageTransitionEffect): void {
    void runTransitionCommand({ enter: effect });
  }
  function handleChangeEnterDuration(duration: number): void {
    void runTransitionCommand({ enterDuration: duration });
  }
  function handleChangeExitEffect(effect: PageTransitionEffect): void {
    void runTransitionCommand({ exit: effect });
  }
  function handleChangeExitDuration(duration: number): void {
    void runTransitionCommand({ exitDuration: duration });
  }
  function handleApplyAll(): void {
    void runTransitionCommand({ all: true });
  }

  return (
    <PageTransitionView
      transition={transition}
      onChangeEnterEffect={handleChangeEnterEffect}
      onChangeEnterDuration={handleChangeEnterDuration}
      onChangeExitEffect={handleChangeExitEffect}
      onChangeExitDuration={handleChangeExitDuration}
      onApplyAll={handleApplyAll}
    />
  );
}
