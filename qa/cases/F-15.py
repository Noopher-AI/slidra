"""F-15：demo 第 3 頁「三行文字下方的真空白」拖曳出現框選（父票 NOOP-347）。

依賴 NOOP-346（GitHub #280）尚未交付的沙箱 QA 層：`quick_start.sh --qa`
起環境，`qa/agent_helpers.py` 提供下列固定原語（#280 逐字定義）——這支腳本
只用這個清單，不新增原語、不改寫成別的 harness（例如 Playwright e2e）：

    open_deck() / goto_slide(n) / select(name_or_id) / selection() /
    drag(from_xy, to_xy, steps=10) / slide_svg(n) / status_bar() /
    console_errors() / shot(name)

本輪查證（NOOP-359, 2026-09-10）：`gh pr list --repo Noopher-AI/co-motion
--state open` 回傳零筆，repo 裡也沒有 qa/ 目錄——NOOP-346 尚未交付，這支
腳本本輪只能交付、無法執行（qa/agent_helpers.py 不存在，import 會直接失
敗）。`selection()` 回傳值的確切欄位名稱 #280 沒有逐字定義，下面
`selection()["box"]["x"/"y"]` 是依 #280 的文字描述（"選取框...在父文件座
標系的位置"）猜測的形狀，NOOP-346 落地後可能要跟著調整。

判準：demo 第 3 頁在 base 上有一個滿版背景 rect（el-WZX2BUPDpa8S，畫布上
任一點都命中它），所以「拖曳空白」在 base 上永遠解析成 move 手勢——會真
的搬動這個 rect 並寫檔。本票移除了這個 rect，同樣的拖曳在分支上因為起點
沒有任何元素而是 marquee 手勢，不寫檔。「檔案位元組是否改變」與「狀態列
選取結果」在 base／分支上必然相反，是下面兩組獨立判準的來源。
"""

import sys

from agent_helpers import (
    console_errors,
    drag,
    goto_slide,
    open_deck,
    select,
    selection,
    shot,
    slide_svg,
    status_bar,
)

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()
    goto_slide(3)
    before = slide_svg(3)

    # 座標換算：demo/slides/003.svg 的三行文字 baseline 分別是 y=300/390/480
    # （字級相同，高度相等），用「第一點」「第三點」量出使用者座標→父文件座
    # 標的縮放與原點，再用「第二點」自檢——換算錯了後面的 PASS/FAIL 都不可
    # 信，所以自檢不過就直接以非零碼結束，不繼續跑手勢。
    select("第一點")
    p1 = selection()["box"]
    goto_slide(3)
    select("第三點")
    p3 = selection()["box"]
    goto_slide(3)

    scale = (p3["y"] - p1["y"]) / (480 - 300)
    origin_x = p1["x"] - 640 * scale
    origin_y = p1["y"] - 300 * scale

    def to_page(x: float, y: float) -> tuple[float, float]:
        return origin_x + x * scale, origin_y + y * scale

    select("第二點")
    p2 = selection()["box"]
    goto_slide(3)
    expected_x, expected_y = to_page(640, 390)
    self_check_ok = abs(p2["x"] - expected_x) < 4 and abs(p2["y"] - expected_y) < 4
    if not self_check_ok:
        print(
            f"FAIL 座標換算自檢：換算得 ({expected_x:.1f},{expected_y:.1f})，"
            f"「第二點」實測 ({p2['x']:.1f},{p2['y']:.1f})"
        )
        return 1
    print(f"PASS 座標換算自檢：scale={scale:.4f}")

    # 手勢 A（票面指定的手勢）：三行文字下方的真空白往右下拖。
    drag(to_page(200, 560), to_page(1080, 690), steps=10)
    after_a = slide_svg(3)
    bar_a = status_bar()
    check("A-1 檔案位元組未變（拖曳空白不寫檔）", after_a == before, after_a == before)
    check("A-2 狀態列選取區為空（矩形未命中任何元素）", not bar_a, bar_a)
    check("A-3 無 console error", console_errors() == [], console_errors())
    shot("F-15-A")

    goto_slide(3)  # 清掉手勢 A 殘留的選取狀態，避免污染手勢 B 的斷言

    # 手勢 B：矩形涵蓋三行文字但不含標題，驗證「命中元素數」這個訊號。
    drag(to_page(120, 230), to_page(1160, 700), steps=10)
    after_b = slide_svg(3)
    bar_b = status_bar()
    check("B-1 檔案位元組未變（拖曳空白不寫檔）", after_b == before, after_b == before)
    check("B-2 狀態列顯示命中 3 個元素", "Selected: 3 elements" in bar_b, bar_b)
    check("B-3 無 console error", console_errors() == [], console_errors())
    shot("F-15-B")

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
