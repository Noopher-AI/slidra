"""F-09：儲存格編輯中按 Tab 跳到下一格，焦點留在同一個
`INPUT.table-cell-editor`（父票 [E5.T9]／NOOP-354，對應 GitHub #286；本
案例對應 Execute 階段 NOOP-399）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列原語）——這支腳本只用這個清單，不新增原語、不改寫成別的 harness：

    open_deck() / goto_slide(n) / click_ui(selector) / click_at(x, y) /
    cell_box(row, col) / dblclick(x, y) / active_element() / press(key) /
    type_text(text) / slide_svg(n)

`click_ui`/`click_at`/`cell_box`/`press`/`type_text` 是本輪新增（demo 四
頁沒有任何表格，必須先從 Dock › Table 插入——照 e2e/table.test.ts 的 E1
步驟；`qa/agent_helpers.py` 原本也沒有任何打字用的原語）。

判準：base 上 `TableOverlay.tsx` 的 cell-editor `<input>` 完全沒有處理
Tab，falls through 到瀏覽器預設行為——焦點離開這個 input，跳到 dock 的
hand-tool 按鈕（`BUTTON.dock-hand-button`，票面重現的原文），Tab 之後打的
字沒進到任何地方。分支上 Tab 被攔截：先提交本格，編輯換到下一格，且刻意
不透過 `setEditing(null)` 中間值卸載再掛載——焦點全程留在同一個
`INPUT.table-cell-editor`。PASS/FAIL 的判準就是 Tab 之後 `active_element()`
是不是還是那個 input。
"""

import re
import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _cell_markup(svg: str, row: int, col: int) -> str:
    match = re.search(rf'<g data-comot-cell="{row},{col}"[^>]*>.*?</g>', svg, re.S)
    if not match:
        raise RuntimeError(f"找不到儲存格 ({row},{col})")
    return match.group(0)


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
    goto_slide(1)  # noqa: F821

    # 從 Dock › Table 插入一張 3×4 表格（e2e/table.test.ts 的 E1 步驟）——
    # demo 四頁沒有任何表格，Tab 跳格要有格子可跳。
    click_ui('button[aria-label="Table"]')  # noqa: F821
    click_ui('.table-panel-cell[aria-label="3 × 4"]')  # noqa: F821
    click_ui(".table-panel-insert")  # noqa: F821

    box00 = _poll(lambda: cell_box(0, 0), lambda b: b is not None)  # noqa: F821
    if box00 is None:
        print("FAIL: cell_box(0, 0) expected=not None actual=None（表格沒插入成功）")
        return 1

    # 先點一下再雙擊——一張從未被選取過的表格，第一次雙擊會跟
    # TableOverlay 自己的 mount effect 賽跑（e2e/table.test.ts E8 的註解已
    # 記錄這個現象，不是 Tab 功能本身的缺陷）。
    click_at(box00["x"] + box00["width"] / 2, box00["y"] + box00["height"] / 2)  # noqa: F821
    dblclick(box00["x"] + box00["width"] / 2, box00["y"] + box00["height"] / 2)  # noqa: F821

    ae = _poll(  # noqa: F821
        lambda: active_element(),
        lambda a: a.get("tag") == "INPUT" and "table-cell-editor" in (a.get("class") or ""),
    )
    check("雙擊 (0,0) 後進入編輯：active_element() 是 INPUT.table-cell-editor", ae.get("tag") == "INPUT" and "table-cell-editor" in (ae.get("class") or ""), ae)

    type_text("A1")  # noqa: F821
    press("Tab")  # noqa: F821

    ae_after_tab = _poll(  # noqa: F821
        lambda: active_element(),
        lambda a: a.get("tag") == "INPUT" and "table-cell-editor" in (a.get("class") or ""),
    )
    check(
        "Tab 之後：active_element() 仍是 INPUT.table-cell-editor（沒有跑到 dock 的 hand-tool 按鈕）",
        ae_after_tab.get("tag") == "INPUT" and "table-cell-editor" in (ae_after_tab.get("class") or ""),
        ae_after_tab,
    )
    check("Tab 之後：焦點不在 iframe 裡（cell-editor 的 input 畫在父文件的覆蓋層上）", ae_after_tab.get("in_iframe") is False, ae_after_tab)

    type_text("B1")  # noqa: F821
    press("Enter")  # noqa: F821

    after = _poll(  # noqa: F821
        lambda: slide_svg(1),
        lambda svg: ">A1<" in svg and ">B1<" in svg,
    )
    check("提交後：slide_svg(1) 讀回 (0,0)=A1", ">A1<" in _cell_markup(after, 0, 0), _cell_markup(after, 0, 0))
    check("提交後：slide_svg(1) 讀回 (0,1)=B1（Tab 打的字真的進到下一格）", ">B1<" in _cell_markup(after, 0, 1), _cell_markup(after, 0, 1))

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
