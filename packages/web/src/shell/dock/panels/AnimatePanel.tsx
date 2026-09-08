import { useState } from "react";
import { SUPPORTED_EFFECTS, SUPPORTED_STARTS, type EffectFamily, type EffectName, type EffectStart } from "../../../effects.js";
import type { CanvasController, CanvasSelection } from "../../../canvas.js";

export interface AnimatePanelProps {
  selection: CanvasSelection;
  controller: CanvasController | null;
  slidePath: string | null;
  /** Called once `effect add` has actually succeeded — switches the right rail to Animate › Object (GUI behaviour table). */
  onAdded(): void;
  onClose(): void;
}

const FAMILIES: readonly EffectFamily[] = ["enter", "emphasis", "exit", "path", "media"];

/**
 * Animate 插入面板（NOOP-66/#206 §4.5）：效果卡（依家族分頁，循環預覽用
 * CSS，不走 runtime——見 animate.css 的 `.animate-panel-effect-preview`）、
 * Start／Duration／Delay，`family="path"` 多一個 `d` 欄位（D3：其餘家族沒有
 * d，一給就不合法，這裡直接不渲染那個欄位而不是渲染後禁用它）。按 Add
 * animation 送一次 `effect add`，`elementIds` 是目前選取的全部元素——多選時
 * 對應 feature「群組動畫」的散元素情境（D5：core 端自動讓第一筆帶這裡選的
 * start，其餘 with-previous），選取單一群組 `<g>` 時是同一條命令、只是
 * `elementIds` 剛好只有一個 id，core 端自然只產生一筆項目。
 */
export function AnimatePanel({ selection, controller, slidePath, onAdded, onClose }: AnimatePanelProps) {
  const [family, setFamily] = useState<EffectFamily>("enter");
  const [effect, setEffect] = useState<EffectName>(SUPPORTED_EFFECTS.enter[0]);
  const [start, setStart] = useState<EffectStart>("on-click");
  const [duration, setDuration] = useState(0.6);
  const [delay, setDelay] = useState(0);
  const [d, setD] = useState("");
  const [pending, setPending] = useState(false);

  function chooseFamily(next: EffectFamily): void {
    setFamily(next);
    setEffect(SUPPORTED_EFFECTS[next][0]);
  }

  const canAdd = selection.ids.length > 0 && slidePath !== null && (family !== "path" || d.trim().length > 0);

  async function addAnimation(): Promise<void> {
    if (!controller || !slidePath || !canAdd) return;
    setPending(true);
    const result = await controller.runCommand("effect add", {
      slidePath,
      elementIds: [...selection.ids],
      family,
      effect,
      start,
      duration,
      delay,
      ...(family === "path" ? { d } : {}),
    });
    setPending(false);
    if (result.ok) {
      onAdded();
      onClose();
    }
  }

  return (
    <div className="floating-layer dock-panel animate-panel" role="dialog" aria-label="Animate">
      <div className="animate-panel-families" role="tablist" aria-label="Effect family">
        {FAMILIES.map((familyName) => (
          <button
            key={familyName}
            type="button"
            role="tab"
            aria-selected={family === familyName}
            onClick={() => chooseFamily(familyName)}
          >
            {familyName}
          </button>
        ))}
      </div>
      <div className="animate-panel-gallery" role="listbox" aria-label="Effect">
        {SUPPORTED_EFFECTS[family].map((name) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={effect === name}
            className="animate-panel-effect-card"
            onClick={() => setEffect(name)}
          >
            <span className="animate-panel-effect-preview" data-effect={name} aria-hidden="true" />
            {name}
          </button>
        ))}
      </div>
      <div className="animate-panel-fields">
        <label className="animate-panel-field">
          <span>Start</span>
          <select value={start} onChange={(event) => setStart(event.target.value as EffectStart)}>
            {SUPPORTED_STARTS.map((startValue) => (
              <option key={startValue} value={startValue}>
                {startValue}
              </option>
            ))}
          </select>
        </label>
        <label className="animate-panel-field">
          <span>Duration</span>
          <input type="number" min={0} step={0.1} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
        </label>
        <label className="animate-panel-field">
          <span>Delay</span>
          <input type="number" min={0} step={0.1} value={delay} onChange={(event) => setDelay(Number(event.target.value))} />
        </label>
        {family === "path" && (
          <label className="animate-panel-field animate-panel-field-wide">
            <span>Path (d)</span>
            <input type="text" value={d} onChange={(event) => setD(event.target.value)} placeholder="M 0 0 L 100 100" />
          </label>
        )}
      </div>
      <button type="button" className="animate-panel-add" disabled={!canAdd || pending} onClick={() => void addAnimation()}>
        Add animation
      </button>
    </div>
  );
}
