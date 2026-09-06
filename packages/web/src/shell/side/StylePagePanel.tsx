import type { PageStyle } from "@co-motion/core/slide";
import type { CanvasController } from "../../canvas.js";
import type { StyleReadResult } from "../../style-attrs.js";
import { StyleField } from "./style/StyleField.js";

export interface StylePagePanelProps {
  /** `null` when there is no current slide (`CanvasState.pageStyle`'s own contract) — the whole tab renders disabled then (§4.6). */
  pageStyle: PageStyle | null;
  /** `project.json`'s `canvas`; `null` before the titlebar's own `/api/presentation` load has resolved. */
  canvasSize: { width: number; height: number } | null;
  controller: CanvasController | null;
}

/** #200 §4.3, values from `docs/design/prototype/comotion-logic-v3.js:571-573`. */
const SIZE_PRESETS: readonly { label: string; width: number; height: number }[] = [
  { label: "16:9", width: 1280, height: 720 },
  { label: "4:3", width: 1024, height: 768 },
  { label: "16:10", width: 1280, height: 800 },
  { label: "A4", width: 1123, height: 794 },
];

function valueOrUnset(value: string | null): StyleReadResult {
  return value === null ? { kind: "unset" } : { kind: "value", value };
}

/**
 * Style › Page (#200 §4.3/§4.4): Background/Accent go through `slide style
 * set` and land in history; the size controls go through `presentation
 * canvas set` and never do (#200 決定 4) — same `StyleField` component
 * either way, the difference is only which command `onCommit` calls.
 */
export function StylePagePanel({ pageStyle, canvasSize, controller }: StylePagePanelProps) {
  if (pageStyle === null || canvasSize === null) {
    return (
      <div className="style-page-panel" role="tabpanel" aria-label="Style · Page">
        <p className="style-panel-empty">沒有可編輯的投影片</p>
      </div>
    );
  }

  async function setPageStyle(update: { background?: string; accent?: string }): Promise<boolean> {
    return controller ? controller.setPageStyle(update) : false;
  }

  async function setCanvasSize(width: number, height: number): Promise<boolean> {
    return controller ? controller.setCanvasSize(width, height) : false;
  }

  return (
    <div className="style-page-panel" role="tabpanel" aria-label="Style · Page">
      <fieldset className="style-section" data-section="page-color">
        <legend>Page</legend>
        <StyleField
          attr="background"
          label="Background"
          control="text"
          current={valueOrUnset(pageStyle.background)}
          resetKey={`background:${pageStyle.background ?? ""}`}
          onCommit={(value) => setPageStyle({ background: value })}
        />
        <StyleField
          attr="accent"
          label="Accent"
          control="text"
          current={valueOrUnset(pageStyle.accent)}
          resetKey={`accent:${pageStyle.accent ?? ""}`}
          onCommit={(value) => setPageStyle({ accent: value })}
        />
      </fieldset>
      <fieldset className="style-section" data-section="page-size">
        <legend>Slide size</legend>
        <div className="style-page-presets">
          {SIZE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="style-page-preset"
              onClick={() => void setCanvasSize(preset.width, preset.height)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <StyleField
          attr="canvas-width"
          label="Width"
          control="number"
          min={320}
          max={4096}
          current={{ kind: "value", value: String(canvasSize.width) }}
          resetKey={`width:${canvasSize.width}`}
          onCommit={(value) => setCanvasSize(Number(value), canvasSize.height)}
        />
        <StyleField
          attr="canvas-height"
          label="Height"
          control="number"
          min={320}
          max={4096}
          current={{ kind: "value", value: String(canvasSize.height) }}
          resetKey={`height:${canvasSize.height}`}
          onCommit={(value) => setCanvasSize(canvasSize.width, Number(value))}
        />
        <button
          type="button"
          className="style-page-swap"
          onClick={() => void setCanvasSize(canvasSize.height, canvasSize.width)}
        >
          Swap orientation
        </button>
      </fieldset>
    </div>
  );
}
