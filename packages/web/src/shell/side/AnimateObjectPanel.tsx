import { useEffect, useState } from "react";
import type { EffectName, EffectStart } from "@co-motion/core/effects";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { buildCards } from "./animate/cards.js";
import { ObjectList } from "./animate/ObjectList.js";
import { Timeline } from "./animate/Timeline.js";
import { useSlideEffects } from "./animate/useSlideEffects.js";

export interface AnimateObjectPanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

type View = "list" | "timeline";

/**
 * 動畫 › Object（NOOP-66/#206 §4.5）：清單視圖與時間軸視圖共用同一份卡片
 * 資料（`useSlideEffects`），每個操作即時送出對應的 `effect` 命令並立即
 * 入歷史（D14：一次命令＝一次 `writePresentationFile`＝一筆 undo，這裡不寫
 * 任何 undo 程式碼）。命令成功後呼叫 `refresh()` 重新讀檔——不等下一次不
 * 相干的 reload() 才看到自己剛做的改動。
 */
export function AnimateObjectPanel({ state, controller }: AnimateObjectPanelProps) {
  const [view, setView] = useState<View>("list");
  const { effects, targetInfo, refresh } = useSlideEffects(state);
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;

  // Esc during Preview returns to the view immediately (GUI table: "預覽中
  // 按 Esc 或點畫面 -> 立即 exitPreview()") — the runtime's own
  // "preview-done" already handles the "let it finish playing" path;
  // this is the user-cancel path on top of it.
  useEffect(() => {
    if (state.mode !== "preview") return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") controller?.exitPreview();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.mode, controller]);

  if (!slidePath || effects === null) {
    return <div className="animate-object-panel" role="tabpanel" aria-label="動畫 · Object" />;
  }

  const cards = buildCards(effects, targetInfo);

  async function runEffectCommand(name: string, input: Record<string, unknown>): Promise<void> {
    if (!controller || !slidePath) return;
    const result = await controller.runCommand(name, { slidePath, ...input });
    if (result.ok) refresh();
  }

  function handleChangeEffect(index: number, effect: EffectName): void {
    void runEffectCommand("effect set", { index: index + 1, effect });
  }
  function handleChangeStart(index: number, start: EffectStart): void {
    void runEffectCommand("effect set", { index: index + 1, start });
  }
  function handleChangeDuration(index: number, duration: number): void {
    void runEffectCommand("effect set", { index: index + 1, duration });
  }
  function handleChangeDelay(index: number, delay: number): void {
    void runEffectCommand("effect set", { index: index + 1, delay });
  }
  function handleMove(index: number, direction: "up" | "down"): void {
    void runEffectCommand("effect move", { index: index + 1, direction });
  }
  function handleRemove(index: number): void {
    void runEffectCommand("effect remove", { indices: [index + 1] });
  }
  function handlePreviewCard(index: number): void {
    void controller?.previewEffects([index]);
  }

  return (
    <div className="animate-object-panel" role="tabpanel" aria-label="動畫 · Object">
      <div className="animate-object-toolbar">
        <div className="animate-object-view-toggle" role="tablist" aria-label="List / Timeline">
          <button type="button" role="tab" aria-selected={view === "list"} onClick={() => setView("list")}>
            List
          </button>
          <button type="button" role="tab" aria-selected={view === "timeline"} onClick={() => setView("timeline")}>
            Timeline
          </button>
        </div>
        <button
          type="button"
          className="animate-object-preview-all"
          disabled={cards.length === 0}
          onClick={() => void controller?.previewEffects(null)}
        >
          Preview
        </button>
      </div>
      {view === "list" ? (
        <ObjectList
          cards={cards}
          onChangeEffect={handleChangeEffect}
          onChangeStart={handleChangeStart}
          onChangeDuration={handleChangeDuration}
          onChangeDelay={handleChangeDelay}
          onMove={handleMove}
          onRemove={handleRemove}
          onPreview={handlePreviewCard}
        />
      ) : (
        <Timeline cards={cards} onMove={handleMove} onChangeDelay={handleChangeDelay} onChangeDuration={handleChangeDuration} />
      )}
    </div>
  );
}
