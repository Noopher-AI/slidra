"""N-03：投影片 iframe 內任何雙擊都不得產生可見的文字選取（父票
[E5.T9]／NOOP-354，對應 GitHub #286 的 #279 修復清單；本案例對應 Execute
階段 NOOP-399）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列原語）——這支腳本只用這個清單，不新增原語、不改寫成別的 harness：

    open_deck() / goto_slide(n) / select(name_or_id) / click_ui(selector) /
    click_at(x, y) / cell_box(row, col) / dblclick(x, y) / active_element() /
    press(key) / iframe_selection_text() / edit_textarea_user_select() /
    slide_svg(n)

`click_ui`/`click_at`/`cell_box`/`press`/`iframe_selection_text`/
`edit_textarea_user_select` 是本輪新增（demo 四頁沒有表格，且原本沒有任
何檢查投影片 iframe 原生選字狀態的原語）。

拍板依據（qa/README.md §4「偶發缺陷的豁免寫法」，N-03 本身就是該節的例
子）：原始重現是偶發的（10 次 1 次），不要求案例腳本重現它；改成防禦性
描述——不論雙擊會不會刷出選字，投影片 iframe 內 `window.getSelection()`
永遠不該不是空字串。本案例只要求 PR 分支 PASS（票面豁免，不要求對 base
重跑）。
"""

import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _poll(fn, want_ok, timeout=10.0, interval=0.1):
    """Polls `fn()` until `want_ok(fn())` is true or `timeout` elapses.
    Returns the last value seen either way — PASS/FAIL is always decided
    by the case script's own `check()` call, never by this helper."""
    deadline = time.time() + timeout
    value = fn()
    while time.time() < deadline:
        value = fn()
        if want_ok(value):
            return value
        time.sleep(interval)
    return value


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821

    # 從 Dock › Table 插入一張 3×4 表格（e2e/table.test.ts 的 E1 步驟／票
    # 面原文「第 3 頁插入 3×4 表格」）。
    click_ui('button[aria-label="Table"]')  # noqa: F821
    click_ui('.table-panel-cell[aria-label="3 × 4"]')  # noqa: F821
    click_ui(".table-panel-insert")  # noqa: F821

    box11 = _poll(lambda: cell_box(1, 1), lambda b: b is not None)  # noqa: F821
    if box11 is None:
        print("FAIL: cell_box(1, 1) expected=not None actual=None（表格沒插入成功）")
        return 1
    cell_x, cell_y = box11["x"] + box11["width"] / 2, box11["y"] + box11["height"] / 2

    # 先點一下再雙擊（e2e/table.test.ts E8 的冷啟動賽跑，同 F-09.py）。
    click_at(cell_x, cell_y)  # noqa: F821

    for i in range(10):
        dblclick(cell_x, cell_y)  # noqa: F821
        sel = iframe_selection_text()  # noqa: F821
        check(f"雙擊儲存格 #{i + 1}：iframe 內 getSelection() 為空", sel == "", sel)
        ae = _poll(  # noqa: F821
            lambda: active_element(),
            lambda a: a.get("tag") == "INPUT" and "table-cell-editor" in (a.get("class") or ""),
        )
        check(
            f"雙擊儲存格 #{i + 1}：仍照常開出 INPUT.table-cell-editor（防禦性修法沒擋住正常雙擊）",
            ae.get("tag") == "INPUT" and "table-cell-editor" in (ae.get("class") or ""),
            ae,
        )
        press("Escape")  # noqa: F821

    sel_result = select("第一點")  # noqa: F821
    plain_box = sel_result["box"]
    if plain_box is None:
        print("FAIL: select('第一點')['box'] expected=not None actual=None")
        return 1
    plain_x, plain_y = plain_box["x"] + plain_box["w"] / 2, plain_box["y"] + plain_box["h"] / 2

    for i in range(10):
        dblclick(plain_x, plain_y)  # noqa: F821
        sel = iframe_selection_text()  # noqa: F821
        check(f"雙擊投影片文字 #{i + 1}：iframe 內 getSelection() 為空", sel == "", sel)
        press("Escape")  # noqa: F821

    # 就地編輯 textarea 本身刻意排除在 user-select:none 之外——它是打字用
    # 的 IME 接收器，雙擊仍要能選字。再進一次編輯，量它的 computed style。
    dblclick(plain_x, plain_y)  # noqa: F821
    user_select = _poll(lambda: edit_textarea_user_select(), lambda v: v is not None)  # noqa: F821
    check("就地編輯 textarea 的 computed user-select 仍是 text（雙擊仍能選字）", user_select == "text", user_select)
    press("Escape")  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
