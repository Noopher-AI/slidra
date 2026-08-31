import { useEffect, useState } from "react";
import type { CanvasController, CanvasState } from "../canvas.js";
import type { SlideElement } from "@co-motion/core/slide";
import {
  PANEL_STYLE_ATTRIBUTES,
  summarizeSelection,
  type PanelStyleAttribute,
  type StyleReadResult,
} from "../style-attrs.js";

export interface StylePanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

type ControlKind = "text" | "number" | "select";

interface FieldSpec {
  attr: PanelStyleAttribute;
  control: ControlKind;
  min?: number;
  max?: number;
}

/** NOOP-143 §4.1: the eight fields, in the fixed order the panel renders them. */
const FIELD_SPECS: readonly FieldSpec[] = [
  { attr: "fill", control: "text" },
  { attr: "stroke", control: "text" },
  { attr: "stroke-width", control: "number", min: 0 },
  { attr: "font-family", control: "text" },
  { attr: "font-size", control: "number", min: 0 },
  { attr: "font-weight", control: "text" },
  { attr: "text-anchor", control: "select" },
  { attr: "opacity", control: "number", min: 0, max: 1 },
];

const FIELD_LABELS: Record<Exclude<PanelStyleAttribute, "fill">, string> = {
  stroke: "框線顏色",
  "stroke-width": "框線粗細",
  "font-family": "字型",
  "font-size": "字級",
  "font-weight": "字重",
  "text-anchor": "框內對齊",
  opacity: "透明度",
};

function displayValueOf(result: StyleReadResult): string {
  return result.kind === "value" ? result.value : "";
}

function placeholderOf(result: StyleReadResult): string | undefined {
  if (result.kind === "unset") return "未設定";
  if (result.kind === "mixed") return "不一致";
  return undefined;
}

/** §4.1: "填色"／"文字顏色" share the `fill` field; the label switches on whether the selection is (all/none/some) text boxes. */
function fillLabelFor(elements: readonly SlideElement[]): string {
  const allTextBoxes = elements.every((element) => element.textWidth !== null);
  if (allTextBoxes) return "文字顏色";
  const anyTextBoxes = elements.some((element) => element.textWidth !== null);
  return anyTextBoxes ? "填色／文字顏色" : "填色";
}

/**
 * 樣式面板 (NOOP-143). Shows the current style values of whatever is
 * selected on the canvas and writes changes back through
 * `controller.setStyle` — the only entry point into `element style set`.
 * Mounted in App.tsx's `shellVisible` block, ahead of the chat sidebar
 * (plan §1 decision 1); absent from the DOM in play mode the same way.
 */
export function StylePanel({ state, controller }: StylePanelProps) {
  // §4.4: an id the current model no longer has (a reload raced the
  // selection) is dropped; if every id drops out, treat it as selecting
  // nothing rather than throwing or showing stale values.
  const elements = state.selection.elements.filter((element): element is SlideElement => element !== null);

  if (elements.length === 0) {
    return (
      <aside className="style-panel">
        <p className="style-panel-empty">選取元素以檢視樣式</p>
      </aside>
    );
  }

  const hasGroup = elements.some((element) => element.kind === "group");
  const hasTextBox = elements.some((element) => element.textWidth !== null);
  const selectionKey = state.selection.ids.join(",");

  return (
    <aside className="style-panel">
      {hasGroup && <p className="style-panel-note">群組沒有可套用樣式的圖元</p>}
      {FIELD_SPECS.map((spec) => (
        <StyleFieldRow
          key={spec.attr}
          spec={spec}
          label={spec.attr === "fill" ? fillLabelFor(elements) : FIELD_LABELS[spec.attr]}
          summarized={summarizeSelection(elements, spec.attr)}
          disabled={hasGroup || (spec.attr === "text-anchor" && hasTextBox)}
          note={!hasGroup && spec.attr === "text-anchor" && hasTextBox ? "文字框不支援" : null}
          controller={controller}
          selectionKey={selectionKey}
        />
      ))}
    </aside>
  );
}

interface StyleFieldRowProps {
  spec: FieldSpec;
  label: string;
  summarized: StyleReadResult;
  disabled: boolean;
  note: string | null;
  controller: CanvasController | null;
  selectionKey: string;
}

function StyleFieldRow({ spec, label, summarized, disabled, note, controller, selectionKey }: StyleFieldRowProps) {
  const original = displayValueOf(summarized);
  const [draft, setDraft] = useState(original);
  const summarizedValue = summarized.kind === "value" ? summarized.value : undefined;

  // Resets the draft whenever what "the current value" means changes: a
  // different selection, this attr's own value moving in the file (after a
  // successful command, or someone else's edit landing via live reload).
  // Never on a mere re-render — the dependency list is the identity of the
  // value, not a fresh object/array reference.
  useEffect(() => {
    setDraft(original);
  }, [selectionKey, summarized.kind, summarizedValue]);

  async function commit(nextValue: string): Promise<void> {
    // §4.6: unchanged or cleared-to-empty never submits — an empty string
    // reverts to the value shown before the edit rather than being treated
    // as "delete this attribute" (the command layer has no such op).
    if (nextValue === "" || nextValue === original) {
      setDraft(original);
      return;
    }
    if (!controller) return;
    const ok = await controller.setStyle(spec.attr, nextValue);
    if (!ok) setDraft(original);
  }

  const dataState = summarized.kind;

  if (spec.control === "select") {
    const showPlaceholderOption = dataState !== "value";
    return (
      <label className="style-field" data-attr={spec.attr}>
        <span className="style-field-label">{label}</span>
        <select
          data-attr={spec.attr}
          data-state={dataState}
          disabled={disabled}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            void commit(value);
          }}
        >
          {showPlaceholderOption && <option value="">{dataState === "unset" ? "未設定" : "不一致"}</option>}
          <option value="start">start</option>
          <option value="middle">middle</option>
          <option value="end">end</option>
        </select>
        {note && <span className="style-field-note">{note}</span>}
      </label>
    );
  }

  return (
    <label className="style-field" data-attr={spec.attr}>
      <span className="style-field-label">{label}</span>
      <input
        type={spec.control === "number" ? "number" : "text"}
        data-attr={spec.attr}
        data-state={dataState}
        placeholder={placeholderOf(summarized)}
        disabled={disabled}
        min={spec.min}
        max={spec.max}
        step={spec.control === "number" ? "any" : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => void commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void commit((event.target as HTMLInputElement).value);
        }}
      />
      {note && <span className="style-field-note">{note}</span>}
    </label>
  );
}
