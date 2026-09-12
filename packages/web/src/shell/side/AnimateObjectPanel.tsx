import { useEffect } from "react";
import type { EffectName, EffectStart } from "../../effects.js";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { buildCards } from "./animate/cards.js";
import { ObjectList } from "./animate/ObjectList.js";
import { useSlideEffects } from "./animate/useSlideEffects.js";

export interface AnimateObjectPanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/**
 * Animate > Object (§4.5): the list view (`useSlideEffects` supplies the
 * card data); each action immediately sends the corresponding `effect`
 * command and lands in history right away (D14: one command = one
 * `writePresentationFile` = one undo entry, so no undo code is written
 * here). Calls `refresh()` to re-read the file after a command succeeds —
 * it doesn't wait for the next unrelated reload() to see its own change.
 */
export function AnimateObjectPanel({ state, controller }: AnimateObjectPanelProps) {
  const { effects, targetInfo, refresh } = useSlideEffects(state);
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;

  // Esc during Preview returns to the view immediately (GUI table: "pressing
  // Esc or clicking the screen while previewing -> exitPreview() right away")
  // — the runtime's own
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
        <button
          type="button"
          className="animate-object-preview-all"
          disabled={cards.length === 0}
          onClick={() => void controller?.previewEffects(null)}
        >
          Preview
        </button>
      </div>
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
    </div>
  );
}
