import { useEffect, useState, type ChangeEvent } from "react";
import type { BackgroundImage, PageStyle } from "../../slide-dom.js";
import { fetchAssetList, type CanvasController } from "../../canvas.js";
import type { StyleReadResult } from "../../style-attrs.js";
import { StyleField } from "./style/StyleField.js";

export interface StylePagePanelProps {
  /** `null` when there is no current slide (`CanvasState.pageStyle`'s own contract) — the whole tab renders disabled then (§4.6). */
  pageStyle: PageStyle | null;
  /** #303：目前 slide 的背景圖片，`null` 表示沒有 slide 或這一頁沒有背景圖片。 */
  backgroundImage: BackgroundImage | null;
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
export function StylePagePanel({ pageStyle, backgroundImage, canvasSize, controller }: StylePagePanelProps) {
  const [assetList, setAssetList] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchAssetList().then((entries) => {
      if (!cancelled) setAssetList(entries);
    });
    return () => {
      cancelled = true;
    };
    // 每次掛載抓一次即可——上傳新檔後的清單更新走 setBackgroundImage 之後
    // 的手動 append（見下方 handleFileInput），不需要重新 fetch。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function setBackgroundImage(update: { asset?: string; none?: boolean; opacity?: number }): Promise<boolean> {
    return controller ? controller.setBackgroundImage(update) : false;
  }

  async function setCanvasSize(width: number, height: number): Promise<boolean> {
    return controller ? controller.setCanvasSize(width, height) : false;
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || !controller) return;
    const imported = await controller.importAsset(file);
    if (!imported.ok) return;
    // `assetList` holds bare filenames under assets/ (matching `/api/assets`'s
    // shape), while `importAsset` returns a full "assets/x" virtual path.
    const name = imported.data.path.startsWith("assets/") ? imported.data.path.slice("assets/".length) : imported.data.path;
    setAssetList((prev) => (prev.includes(name) ? prev : [...prev, name]));
    await setBackgroundImage({ asset: imported.data.path });
  }

  function handleAssetSelect(event: ChangeEvent<HTMLSelectElement>): void {
    const asset = event.target.value;
    if (asset === "") return;
    void setBackgroundImage({ asset });
  }

  function handleOpacityChange(event: ChangeEvent<HTMLInputElement>): void {
    if (!backgroundImage) return;
    void setBackgroundImage({ asset: backgroundImage.asset, opacity: Number(event.target.value) });
  }

  return (
    <div
      className="style-page-panel"
      role="tabpanel"
      aria-label="Style · Page"
      // The *live* prop, not a field's own draft — Width/Height are two
      // separate fields over one command that needs both, so an e2e test
      // driving them in quick succession needs a way to tell "the prop this
      // render actually saw" apart from "what the user just typed" (the
      // width field's own `input` value is already the new number the
      // instant it is typed, whether or not this prop has caught up yet).
      data-canvas-width={canvasSize.width}
      data-canvas-height={canvasSize.height}
    >
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
      <fieldset className="style-section" data-section="page-background-image">
        <legend>Background image</legend>
        <label className="style-field" data-attr="background-image-upload">
          <span className="style-field-label">Upload</span>
          <input type="file" accept="image/*" onChange={(event) => void handleFileInput(event)} />
        </label>
        <label className="style-field" data-attr="background-image-select">
          <span className="style-field-label">From assets</span>
          <select value={backgroundImage?.asset ?? ""} onChange={handleAssetSelect}>
            <option value="">未選擇</option>
            {assetList.map((asset) => (
              <option key={asset} value={`assets/${asset}`}>
                {asset}
              </option>
            ))}
          </select>
        </label>
        <label className="style-field" data-attr="background-image-opacity">
          <span className="style-field-label">Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            disabled={backgroundImage === null}
            value={backgroundImage?.opacity ?? 1}
            onChange={handleOpacityChange}
          />
        </label>
        <button
          type="button"
          className="style-page-background-clear"
          disabled={backgroundImage === null}
          onClick={() => void setBackgroundImage({ none: true })}
        >
          Clear
        </button>
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
