import { useEffect, useState } from "react";
import type { StyleReadResult } from "../../../style-attrs.js";

export type StyleFieldControl = "text" | "number" | "select";

export interface StyleFieldOption {
  value: string;
  label: string;
}

export interface StyleFieldProps {
  /** `data-attr` — also the DOM contract e2e locates fields by (5f8709a, §3.3). */
  attr: string;
  label: string;
  control: StyleFieldControl;
  /** Required when `control === "select"`. */
  options?: readonly StyleFieldOption[];
  min?: number;
  max?: number;
  disabled?: boolean;
  note?: string | null;
  current: StyleReadResult;
  /**
   * Identity of "what does the current value mean right now" — the draft resets to
   * `current`'s display value whenever this changes (a different
   * selection/slide, or the value moving under a live reload), never on a
   * bare re-render (5f8709a's own reviewed contract).
   */
  resetKey: string;
  /** Resolves `false` on a failed command — the field then reverts its draft to the pre-edit value; the failure message itself is surfaced elsewhere (`CanvasState.error`). */
  onCommit(nextValue: string): Promise<boolean>;
}

function displayValueOf(result: StyleReadResult): string {
  return result.kind === "value" ? result.value : "";
}

function placeholderOf(result: StyleReadResult): string | undefined {
  if (result.kind === "unset") return "Unset";
  if (result.kind === "mixed") return "Mixed";
  return undefined;
}

/**
 * One Style panel field (§3.3): draft state that resets on
 * `resetKey`, commits on blur/Enter (or immediately on change for a
 * select), reverts to the original value on an empty/unchanged submit or a
 * failed command. Shared by every Style › Object field and Style › Page's
 * Background/Accent — the DOM contract (`data-attr`/`data-state`) is what
 * e2e locates fields by.
 */
export function StyleField({ attr, label, control, options, min, max, disabled, note, current, resetKey, onCommit }: StyleFieldProps) {
  const original = displayValueOf(current);
  const [draft, setDraft] = useState(original);

  useEffect(() => {
    setDraft(original);
    // `resetKey` (plus `original`, which only ever changes alongside it) is
    // the intended dependency — never re-run on a bare re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, original]);

  async function commit(nextValue: string): Promise<void> {
    if (nextValue === "" || nextValue === original) {
      setDraft(original);
      return;
    }
    const ok = await onCommit(nextValue);
    if (!ok) setDraft(original);
  }

  if (control === "select") {
    const showPlaceholder = current.kind !== "value";
    return (
      <label className="style-field" data-attr={attr}>
        <span className="style-field-label">{label}</span>
        <select
          data-attr={attr}
          data-state={current.kind}
          disabled={disabled}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            void commit(value);
          }}
        >
          {showPlaceholder && <option value="">{current.kind === "unset" ? "Unset" : "Mixed"}</option>}
          {(options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {note && <span className="style-field-note">{note}</span>}
      </label>
    );
  }

  return (
    <label className="style-field" data-attr={attr}>
      <span className="style-field-label">{label}</span>
      <input
        type={control}
        data-attr={attr}
        data-state={current.kind}
        placeholder={placeholderOf(current)}
        disabled={disabled}
        min={min}
        max={max}
        step={control === "number" ? "any" : undefined}
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
