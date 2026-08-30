import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { snapTranslation } from "../src/geometry/snap.js";

/**
 * 貼齊（NOOP-91 §4.6）。純函式，期望值全部手算：候選元素的
 * 左／中／右與上／中／下邊，加上畫布的水平與垂直中線。
 */

const CANVAS = { width: 1280, height: 720 };

describe("snapTranslation", () => {
  it("被拖元素的左緣接近候選元素的左緣時，修正量把兩者對齊", () => {
    // moving 左緣 103，候選左緣 100 → 需要 -3 才對齊。
    const result = snapTranslation({
      moving: { x: 103, y: 400, width: 50, height: 50 },
      candidates: [{ id: "el-a", bounds: { x: 100, y: 40, width: 200, height: 20 } }],
      canvas: CANVAS,
      threshold: 8,
    });
    expect(result.dx).toBe(-3);
    expect(result.guides).toContainEqual({ orientation: "v", position: 100 });
  });

  it("超出吸附半徑就不貼齊，也不產生輔助線", () => {
    const result = snapTranslation({
      moving: { x: 120, y: 400, width: 50, height: 50 },
      candidates: [{ id: "el-a", bounds: { x: 100, y: 40, width: 200, height: 20 } }],
      canvas: CANVAS,
      threshold: 8,
    });
    expect(result.dx).toBe(0);
    expect(result.guides).toEqual([]);
  });

  it("候選為空時仍會貼齊畫布中線", () => {
    // moving 中心 x = 638，畫布垂直中線 640 → +2。
    const result = snapTranslation({
      moving: { x: 618, y: 100, width: 40, height: 40 },
      candidates: [],
      canvas: CANVAS,
      threshold: 8,
    });
    expect(result.dx).toBe(2);
    expect(result.guides).toEqual([{ orientation: "v", position: 640 }]);
  });

  it("水平與垂直各自獨立計算，可以同時貼齊兩軸", () => {
    // 中心 (637, 358) → 畫布中線 (640, 360)。
    const result = snapTranslation({
      moving: { x: 617, y: 338, width: 40, height: 40 },
      candidates: [],
      canvas: CANVAS,
      threshold: 8,
    });
    expect(result).toEqual({
      dx: 3,
      dy: 2,
      guides: [
        { orientation: "v", position: 640 },
        { orientation: "h", position: 360 },
      ],
    });
  });

  // 以下兩個案例用零寬候選框，讓每個候選只貢獻一條貼齊線（左＝中＝右），
  // 這樣斷言的是「挑哪一條線」本身，而不是候選框自己的三條線互相干擾。
  it("同一軸有多個命中時取距離最小者", () => {
    // moving 左緣 104。候選 A 的線在 100（距 -4），候選 B 在 106（距 +2）→ 取 B。
    const result = snapTranslation({
      moving: { x: 104, y: 400, width: 50, height: 50 },
      candidates: [
        { id: "el-a", bounds: { x: 100, y: 40, width: 0, height: 0 } },
        { id: "el-b", bounds: { x: 106, y: 40, width: 0, height: 0 } },
      ],
      canvas: CANVAS,
      threshold: 8,
    });
    expect(result.dx).toBe(2);
    expect(result.guides).toContainEqual({ orientation: "v", position: 106 });
  });

  it("距離相同時取 candidates 的先後順序", () => {
    // moving 左緣 100。候選 A 的線在 103（距 +3），候選 B 在 97（距 -3）→ 取 A。
    const result = snapTranslation({
      moving: { x: 100, y: 400, width: 50, height: 50 },
      candidates: [
        { id: "el-a", bounds: { x: 103, y: 40, width: 0, height: 0 } },
        { id: "el-b", bounds: { x: 97, y: 40, width: 0, height: 0 } },
      ],
      canvas: CANVAS,
      threshold: 8,
    });
    expect(result.dx).toBe(3);
    expect(result.guides).toContainEqual({ orientation: "v", position: 103 });
  });

  it("threshold ≤ 0 或非有限數一律拋錯，不得當成「不貼齊」吞掉", () => {
    const input = { moving: { x: 0, y: 0, width: 10, height: 10 }, candidates: [], canvas: CANVAS };
    expect(() => snapTranslation({ ...input, threshold: 0 })).toThrow(CoMotionError);
    expect(() => snapTranslation({ ...input, threshold: -1 })).toThrow(CoMotionError);
    expect(() => snapTranslation({ ...input, threshold: Number.NaN })).toThrow(CoMotionError);
    expect(() => snapTranslation({ ...input, threshold: Number.POSITIVE_INFINITY })).toThrow(CoMotionError);
  });

  it("moving 或 canvas 帶非有限數時拋錯", () => {
    expect(() =>
      snapTranslation({
        moving: { x: Number.NaN, y: 0, width: 10, height: 10 },
        candidates: [],
        canvas: CANVAS,
        threshold: 8,
      }),
    ).toThrow(CoMotionError);
  });
});
