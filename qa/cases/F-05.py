"""F-05：選取後點投影片外圈的深灰舞台底無法取消選取（父票 NOOP-385/NOOP-351，
對應 GitHub #283）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供固定原
語——見 qa/README.md 與 qa/cases/F-15.py 的說明）。本檔額外用到的
`click_at_xy(x, y)`／`js(expression)` 不是 co-motion 專屬原語，是 browser-use
核心本來就有的全域（agent_helpers.py 檔頭 docstring 自己說「every top-level
name not starting with '_' becomes a global... the same way core helpers like
js()/cdp() are」），用來找出並點擊 `.canvas-area` 減去 `.stage` 的那一圈灰底
——「投影片外圈的深灰舞台底」在 DOM 上就是這塊，e2e/stage-navigation.test.ts
的 `gutterPoint()` 已經在用同一個座標公式：

    open_deck() / goto_slide(n) / select(name_or_id) / selection() /
    console_errors() / shot(name) / click_at_xy(x, y) / js(expression)

重現（06-KEYBOARD_AND_GESTURES.md「點空白取消」）：選取第 1 頁標題後，點舞台
外圈一點，base 上選取框、把手、情境列全部留著；本票分支修好後應該清空。
"""

import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def context_bar_present() -> bool:
    return bool(js("document.querySelector('.context-bar') != null"))  # noqa: F821


def wait_selection_cleared(timeout: float = 2.0) -> dict:
    deadline = time.time() + timeout
    last = selection()  # noqa: F821
    while time.time() < deadline and last["chip"] != "":
        time.sleep(0.05)
        last = selection()  # noqa: F821
    return last


def wait_context_bar_gone(timeout: float = 2.0) -> bool:
    """情境列的 `union` 來自 runtime 一趟 postMessage 來回（selection 命令 ->
    updateBoxes() -> bounds 事件 -> canvas.ts 的 overlayUnion -> React 重
    render），比 chip 的清空（同步的 React state）多一段非同步，兩者不會在
    同一個 tick 內同時完成——`wait_selection_cleared()` 回傳後仍要單獨等這
    個信號，不能假設已經一起到位。"""
    deadline = time.time() + timeout
    present = context_bar_present()
    while time.time() < deadline and present:
        time.sleep(0.05)
        present = context_bar_present()
    return present


def main() -> int:
    open_deck()  # noqa: F821
    # goto_slide() 重建投影片 iframe（新的 srcdoc），把前一個 browser-use 呼叫
    # 可能留下的就地編輯狀態（例如 F-02.py 最後一步的雙擊編輯，沒有離開編輯
    # 就結束）一併重置——同一個瀏覽器分頁跨呼叫共用，不能假設乾淨狀態。
    goto_slide(1)  # noqa: F821

    sel = select("標題")  # noqa: F821
    check("A-0 選取後狀態列有 chip", sel["chip"] != "", sel["chip"])
    check("A-1 選取後情境列在 DOM 裡", context_bar_present(), context_bar_present())

    # 舞台外圈：`.canvas-area` 左上角往內 10px——落在 `.canvas-area` 但不在
    # `.stage`（投影片本體）範圍內，同 e2e/stage-navigation.test.ts 的
    # `gutterPoint()`。自檢一次這個點真的落在 `.stage` 之外，版面假設錯了就
    # 直接以非零碼結束，不繼續跑（誤判的 FAIL/PASS 都不可信）。
    backdrop = js(  # noqa: F821
        "(()=>{const w=document.querySelector('.canvas-area');const s=document.querySelector('.stage');"
        "if(!w||!s)return null;const wr=w.getBoundingClientRect();const sr=s.getBoundingClientRect();"
        "const x=wr.x+10,y=wr.y+10;"
        "const insideStage=x>=sr.x&&x<=sr.x+sr.width&&y>=sr.y&&y<=sr.y+sr.height;"
        "return {x:x,y:y,insideStage:insideStage};})()"
    )
    if backdrop is None or backdrop.get("insideStage"):
        print(f"FAIL A-2 座標自檢：舞台外圈的點落在 .stage 之外才有效，實測 {backdrop!r}")
        return 1
    print(f"PASS A-2 座標自檢：{backdrop!r}")

    click_at_xy(backdrop["x"], backdrop["y"])  # noqa: F821
    after = wait_selection_cleared()
    check("B-1 點舞台外圈後選取清空", after["chip"] == "", after)
    bar_still_present = wait_context_bar_gone()
    check("B-2 點舞台外圈後情境列不在 DOM 裡", not bar_still_present, bar_still_present)
    check("B-3 無 console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-05")  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
