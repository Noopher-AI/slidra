import { describe, expect, it } from "vitest";
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_PRESETS,
  initialZoomPan,
  setZoom,
  zoomAtPoint,
  zoomFit,
  panBy,
  formatZoomPercent,
  clientPointToContentPoint,
  initialHandState,
  toggleHand,
  pressSpace,
  releaseSpace,
  isHandActive,
} from "../src/shell/stage-view.js";

// ── 縮放（Zoom） ──────────────────────────────────────────────────────

describe("stage-view: 縮放初始狀態", () => {
  it("initialZoomPan 回傳 100% 縮放、原點平移", () => {
    const state = initialZoomPan();
    expect(state.zoom).toBe(1);
    expect(state.pan).toEqual({ x: 0, y: 0 });
  });
});

describe("stage-view: setZoom 對非法輸入拋出錯誤", () => {
  it("NaN 拋出 Error", () => {
    expect(() => setZoom(initialZoomPan(), NaN)).toThrow(Error);
  });
  it("字串（非數字型別）拋出 Error", () => {
    expect(() => setZoom(initialZoomPan(), "120%" as unknown as number)).toThrow(Error);
  });
  it("Infinity 拋出 Error", () => {
    expect(() => setZoom(initialZoomPan(), Infinity)).toThrow(Error);
  });
});

describe("stage-view: setZoom 對使用者輸入靜默夾限", () => {
  it("0.1 夾到最小值 0.25", () => {
    const next = setZoom(initialZoomPan(), 0.1);
    expect(next.zoom).toBe(ZOOM_MIN);
    expect(next.zoom).toBe(0.25);
  });
  it("10 夾到最大值 4.0", () => {
    const next = setZoom(initialZoomPan(), 10);
    expect(next.zoom).toBe(ZOOM_MAX);
    expect(next.zoom).toBe(4.0);
  });
  it("0.334 這種非預設值原封不動內部保留，不吸附到選單預設值", () => {
    const next = setZoom(initialZoomPan(), 0.334);
    expect(next.zoom).toBe(0.334);
    expect(ZOOM_PRESETS).not.toContain(0.334);
  });
});

describe("stage-view: formatZoomPercent 只有顯示層四捨五入", () => {
  it("0.334 顯示為 33%", () => {
    expect(formatZoomPercent(0.334)).toBe("33%");
  });
  it("1 顯示為 100%", () => {
    expect(formatZoomPercent(1)).toBe("100%");
  });
});

describe("stage-view: pan 不設界（Figma 式，允許把投影片完全平移出畫面外）", () => {
  it("panBy 允許任意大小、含負值的位移", () => {
    const start = initialZoomPan();
    const next = panBy(panBy(start, -100000, 50000), -100000, 50000);
    expect(next.pan).toEqual({ x: -200000, y: 100000 });
  });
});

describe("stage-view: zoomAtPoint 以游標為錨點縮放（游標下的內容點縮放前後不變）", () => {
  it("zoom 1→2、錨點 (100,50)：pan 依錨點不變式手算為 (-100,-50)", () => {
    // 錨點不變式：contentPoint = (anchor - pan) / zoom 縮放前後相等。
    // zoom=1, pan=(0,0) → contentPoint = (100-0)/1 = 100, (50-0)/1 = 50。
    // zoom=2 時要維持 100 = (100 - newPan.x) / 2 → newPan.x = 100 - 200 = -100（同理 y = -50）。
    const start = initialZoomPan();
    const next = zoomAtPoint(start, 2, { x: 100, y: 50 });
    expect(next.zoom).toBe(2);
    expect(next.pan).toEqual({ x: -100, y: -50 });
  });

  it("錨點下的內容座標在縮放前後保持不變（不變式，用不同運算驗證，不重複實作公式）", () => {
    const start = { zoom: 1.5, pan: { x: 40, y: -20 } };
    const anchor = { x: 300, y: 150 };
    const before = clientPointToContentPoint(start, anchor);
    const after = zoomAtPoint(start, 3, anchor);
    const afterContent = clientPointToContentPoint(after, anchor);
    expect(afterContent.x).toBeCloseTo(before.x, 10);
    expect(afterContent.y).toBeCloseTo(before.y, 10);
  });
});

describe("stage-view: zoomFit 重置為 100% 並置中", () => {
  it("從任意 zoom/pan 狀態呼叫都回到初始狀態", () => {
    const arbitrary = { zoom: 3.2, pan: { x: 500, y: -200 } };
    expect(zoomFit(arbitrary)).toEqual(initialZoomPan());
  });
});

describe("stage-view: clientPointToContentPoint（給尚未使用的疊層做座標換算）", () => {
  it("zoom=1, pan=(0,0) 時，畫面座標即內容座標", () => {
    expect(clientPointToContentPoint(initialZoomPan(), { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });
  it("zoom=2, pan=(10,0) 時，依定義 (client - pan) / zoom 換算", () => {
    const state = { zoom: 2, pan: { x: 10, y: 0 } };
    expect(clientPointToContentPoint(state, { x: 30, y: 8 })).toEqual({ x: 10, y: 4 });
  });
});

// ── 抓取模式（Hand mode）／暫時抓取（Space） ─────────────────────────

describe("stage-view: hand-mode 初始狀態", () => {
  it("initialHandState 的 hand 與 spaceHeld 皆為 false", () => {
    const state = initialHandState();
    expect(state.hand).toBe(false);
    expect(state.spaceHeld).toBe(false);
    expect(isHandActive(state)).toBe(false);
  });
});

describe("stage-view: toggleHand 按鈕切換", () => {
  it("從關到開：hand=true，且回報 selectionCleared=true（05-INTERACTIONS.feature「抓取模式」場景）", () => {
    const { state, selectionCleared } = toggleHand(initialHandState());
    expect(state.hand).toBe(true);
    expect(selectionCleared).toBe(true);
  });

  it("從開到關：hand=false，且不回報清除選取", () => {
    const on = toggleHand(initialHandState()).state;
    const { state, selectionCleared } = toggleHand(on);
    expect(state.hand).toBe(false);
    expect(selectionCleared).toBe(false);
  });
});

describe("stage-view: pressSpace／releaseSpace 暫時抓取", () => {
  it("按住 Space 使 isHandActive 為 true，即使按鈕本身的 hand 是 false", () => {
    const pressed = pressSpace(initialHandState());
    expect(pressed.hand).toBe(false);
    expect(pressed.spaceHeld).toBe(true);
    expect(isHandActive(pressed)).toBe(true);
  });

  it("放開 Space 後，若按鈕本來是關的，isHandActive 恢復 false", () => {
    const pressed = pressSpace(initialHandState());
    const released = releaseSpace(pressed);
    expect(released.spaceHeld).toBe(false);
    expect(isHandActive(released)).toBe(false);
  });

  it("放開 Space 後，若按鈕本來就是開的（先按 ✋ 再按 Space），hand 維持開", () => {
    const handOn = toggleHand(initialHandState()).state;
    const pressed = pressSpace(handOn);
    expect(isHandActive(pressed)).toBe(true);
    const released = releaseSpace(pressed);
    expect(released.hand).toBe(true);
    expect(isHandActive(released)).toBe(true);
  });

  it("焦點在文字輸入框時，Space 不得啟用抓取模式", () => {
    const pressed = pressSpace(initialHandState(), { targetIsTextInput: true });
    expect(pressed.spaceHeld).toBe(false);
    expect(isHandActive(pressed)).toBe(false);
  });

  it("releaseSpace 對沒有按住 Space 的狀態是安全的 no-op（視窗失焦時可以直接呼叫，不必先確認狀態）", () => {
    const state = initialHandState();
    expect(releaseSpace(state)).toEqual(state);
  });
});
