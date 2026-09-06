import { useState, type KeyboardEvent } from "react";
import type { CanvasController } from "../../../canvas.js";

export interface TextPanelProps {
  onClose(): void;
  controller: CanvasController | null;
  /** The presentation's own canvas size (project.json's `canvas`) — every preset's size/width/position below is a percentage of THIS, never a hard-coded 1280×720. `null` before it has loaded, which disables Insert. */
  canvasSize: { width: number; height: number } | null;
}

export type Align = "left" | "center" | "right";
export type Preset = "title" | "subtitle" | "body" | "caption";

interface PresetSpec {
  /** Percentage of the canvas WIDTH (原型的 cqw 單位). */
  size: number;
  weight: number;
  /** Percentage of the canvas width. */
  width: number;
  label: string;
  /** Used when the textarea is left empty (原型：文字留空時用預設字串）。 */
  placeholderText: string;
}

// Verbatim from docs/design/prototype/comotion-logic-v3.js:203 (NOOP-65 計畫 §3.8) —
// size/weight/width are percentages of the canvas's own width; positions
// below (§7 決定 t/l) are computed against the ACTUAL open presentation's
// canvas size, never a hard-coded 1280×720.
const PRESETS: Record<Preset, PresetSpec> = {
  title: { size: 5.2, weight: 700, width: 60, label: "Title", placeholderText: "Title" },
  subtitle: { size: 2.8, weight: 500, width: 56, label: "Subtitle", placeholderText: "Subtitle" },
  body: { size: 2.2, weight: 400, width: 50, label: "Body", placeholderText: "Body text" },
  caption: { size: 1.6, weight: 500, width: 40, label: "Caption", placeholderText: "Caption" },
};

const PRESET_ORDER: Preset[] = ["title", "subtitle", "body", "caption"];
const ALIGN_ORDER: { align: Align; label: string }[] = [
  { align: "left", label: "Left" },
  { align: "center", label: "Center" },
  { align: "right", label: "Right" },
];

/** Top offset is fixed at 42% of the canvas height; left depends on alignment (原型 comotion-logic-v3.js:203 一致 — 見計畫 §3.8). */
function positionPercent(align: Align, widthPercent: number): { tPercent: number; lPercent: number } {
  const lPercent = align === "center" ? 50 - widthPercent / 2 : align === "right" ? 92 - widthPercent : 8.4;
  return { tPercent: 42, lPercent };
}

/** `CanvasController.insertTextBox`'s own input shape — re-declared here (not imported from canvas.ts) so this pure function has no dependency on the canvas module, only on the values it computes. */
export interface InsertTextBoxInput {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontWeight: number;
  align: Align;
}

/**
 * NOOP-65r3 §Step 3 — the preset/align → `insertTextBox` input conversion,
 * extracted out of `insert()` below as a pure function so it has a unit
 * test independent of React/DOM (this codebase's React component tests
 * are all `renderToStaticMarkup`, with no testing-library — see
 * `export-panel.test.ts`/`stage-overlays.test.ts` — so an interactive
 * behaviour like this one can only be tested by pulling the computation
 * itself out from under the JSX). Behaviour is unchanged: this is exactly
 * what `insert()` used to compute inline.
 */
export function textPanelInsertInput(
  preset: Preset,
  align: Align,
  text: string,
  canvasSize: { width: number; height: number },
): InsertTextBoxInput {
  const spec = PRESETS[preset];
  const { tPercent, lPercent } = positionPercent(align, spec.width);
  return {
    text: text.trim() === "" ? spec.placeholderText : text,
    x: (canvasSize.width * lPercent) / 100,
    y: (canvasSize.height * tPercent) / 100,
    width: (canvasSize.width * spec.width) / 100,
    fontSize: (canvasSize.width * spec.size) / 100,
    fontWeight: spec.weight,
    align,
  };
}

/**
 * Text 插入面板（NOOP-65 §3.8/A9/A11）：一個 `rows=2` 的 textarea＋四個樣式
 * 預設＋三個對齊按鈕，`Enter`（無 Shift）直接插入，`Shift+Enter` 換行。每個
 * 編輯動作都對應一條 CLI 命令（A11）：這裡對應的是 `textbox add`。
 */
export function TextPanel({ onClose, controller, canvasSize }: TextPanelProps) {
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<Preset>("body");
  const [align, setAlign] = useState<Align>("left");

  const canInsert = canvasSize !== null && controller !== null;

  async function insert(): Promise<void> {
    if (!canInsert || !canvasSize) return;
    await controller!.insertTextBox(textPanelInsertInput(preset, align, text, canvasSize));
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // 原型 textKey：Enter 且非 shiftKey 直接插入；Shift+Enter 是換行
    // （原型的插入面板本身沒有多行內容，這裡沿用同一鍵盤約定）。
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void insert();
    }
  }

  return (
    <div className="floating-layer text-panel" role="dialog" aria-label="Text">
      <textarea
        className="text-panel-input"
        rows={2}
        autoFocus
        placeholder="Type your text… (Enter to insert)"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="text-panel-row" role="group" aria-label="Style preset">
        {PRESET_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            className="text-panel-preset"
            data-preset={key}
            aria-pressed={preset === key}
            onClick={() => setPreset(key)}
          >
            <span className="text-panel-preset-sample">Aa</span>
            <span className="text-panel-preset-label">{PRESETS[key].label}</span>
          </button>
        ))}
      </div>
      <div className="text-panel-row" role="group" aria-label="Alignment">
        {ALIGN_ORDER.map((item) => (
          <button
            key={item.align}
            type="button"
            className="text-panel-align"
            aria-pressed={align === item.align}
            aria-label={item.label}
            title={item.label}
            onClick={() => setAlign(item.align)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button type="button" className="text-panel-insert" disabled={!canInsert} onClick={() => void insert()}>
        Insert
      </button>
    </div>
  );
}
