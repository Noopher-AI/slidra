"""F-15：demo 第 3 頁「三行文字下方的真空白」拖曳出現框選（父票 NOOP-347）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語）——這支腳本只用這個清單，不新增原語、不改寫成別的 harness
（例如 Playwright e2e）：

    open_deck() / goto_slide(n) / select(name_or_id) / selection() /
    drag(from_xy, to_xy, steps=10) / slide_svg(n) / status_bar() /
    console_errors() / shot(name)

NOOP-346（GitHub #280）已於 2026-09-10 交付 `qa/agent_helpers.py`；下面
`selection()["box"]["x"/"y"]` 對照該檔案的 `selection()` docstring 確認無
誤，鍵名是 `x`/`y`/`w`/`h`。原語由 `browser-use` 以 `exec(code, globals())`
注入為全域名稱（見 `qa/cases/smoke.py`），不是可 import 的模組，本檔直接
呼叫它們並在呼叫處加 `# noqa: F821`。

判準：demo 第 3 頁在 base 上有一個滿版背景 rect（el-WZX2BUPDpa8S，畫布上
任一點都命中它），所以「拖曳空白」在 base 上永遠解析成 move 手勢——會真
的搬動這個 rect 並寫檔。本票移除了這個 rect，同樣的拖曳在分支上因為起點
沒有任何元素而是 marquee 手勢，不寫檔。「檔案位元組是否改變」與「狀態列
選取結果」在 base／分支上必然相反，是下面兩組獨立判準的來源。
"""

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821
    before = slide_svg(3)  # noqa: F821

    # 座標換算：demo/slides/003.svg 的三行文字 baseline 分別是 y=300/390/480
    # （字級相同，高度相等），用「第一點」「第三點」量出使用者座標→父文件座
    # 標的縮放與原點，再用「第二點」自檢——換算錯了後面的 PASS/FAIL 都不可
    # 信，所以自檢不過就直接以非零碼結束，不繼續跑手勢。
    select("第一點")  # noqa: F821
    p1 = selection()["box"]  # noqa: F821
    goto_slide(3)  # noqa: F821
    select("第三點")  # noqa: F821
    p3 = selection()["box"]  # noqa: F821
    goto_slide(3)  # noqa: F821

    scale = (p3["y"] - p1["y"]) / (480 - 300)
    origin_x = p1["x"] - 640 * scale
    origin_y = p1["y"] - 300 * scale

    def to_page(x: float, y: float) -> tuple[float, float]:
        return origin_x + x * scale, origin_y + y * scale

    select("第二點")  # noqa: F821
    p2 = selection()["box"]  # noqa: F821
    goto_slide(3)  # noqa: F821
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
    drag(to_page(200, 560), to_page(1080, 690), steps=10)  # noqa: F821
    after_a = slide_svg(3)  # noqa: F821
    bar_a = status_bar()  # noqa: F821
    check("A-1 檔案位元組未變（拖曳空白不寫檔）", after_a == before, after_a == before)
    # status_bar() 回傳整個 footer 的 textContent，含快捷鍵提示與頁碼（見
    # qa/agent_helpers.py 的 docstring）——這兩者與選取狀態無關、永遠存在，
    # 所以「選取區為空」不能斷言整條 bar 是空字串（那永遠是 False，不論有沒
    # 有選到東西），要跟 B-2 用同一種手法：斷言選取 chip 的文字不在 bar 裡。
    check("A-2 狀態列選取區為空（矩形未命中任何元素）", "Selected:" not in bar_a, bar_a)
    check("A-3 無 console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-15-A")  # noqa: F821

    goto_slide(3)  # noqa: F821 - 清掉手勢 A 殘留的選取狀態，避免污染手勢 B 的斷言

    # 手勢 B：矩形涵蓋三行文字但不含標題，驗證「命中元素數」這個訊號。
    drag(to_page(120, 230), to_page(1160, 700), steps=10)  # noqa: F821
    after_b = slide_svg(3)  # noqa: F821
    bar_b = status_bar()  # noqa: F821
    check("B-1 檔案位元組未變（拖曳空白不寫檔）", after_b == before, after_b == before)
    check("B-2 狀態列顯示命中 3 個元素", "Selected: 3 elements" in bar_b, bar_b)
    check("B-3 無 console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-15-B")  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
