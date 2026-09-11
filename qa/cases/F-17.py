"""F-17：情境列擋住下一行可點內容（父票 NOOP-352／GitHub #284，[E5.T7]）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語）——這支腳本只用這個清單，不新增原語、不改寫成別的 harness：

    open_deck() / goto_slide(n) / select(name_or_id, additive=False) /
    selection() / hover(x, y) / click_at(x, y, shift=False) / context_bar() /
    slide_svg(n) / console_errors()

`select`/`hover`/`click_at`/`context_bar` 與 `select` 的 `additive` kwarg 是
本票新增（見 `qa/agent_helpers.py` 對應 docstring）。

判準（Execute 對照 Plan §5 的實測修正，見下方 A/B 各自的說明）：base 上
A、B 兩條都 FAIL（點擊被情境列擋下，選取不變或加選失敗），分支上兩條都
PASS；C 是回歸防線（hover 後仍按得到 Delete），兩邊都應該 PASS。

Execute 時對照 Plan 的兩處修正：
  1. Plan §5(A) 原本指第 1 頁「標題→副標」——實測（`_iframe_offset`／
     `getBoundingClientRect` 直接量）在目前這份 demo 素材＋字型度量下，
     副標的實際 box（y 389–414）與情境列 box（y 417–454）之間有約 3px
     空隙，並不真的重疊，無法用來重現「點擊被擋下」。改用第 3 頁「第一
     點→第二點」（純滑鼠、非 additive）——`elementFromPoint` 直接證實這
     裡選第一點後，第二點的中心點命中的是 `<button class="context-bar-
     item">`，不是 iframe，確實重現。
  2. C 段（hover 後點 Delete）刻意留在第 1 頁，不用第 3 頁：第 3 頁的
     情境列因為多一顆 Edit animation 按鈕而變寬（764px），在 1440px 寬
     的視窗下會被右邊 Chat 面板（x≈1101 起）局部遮住最右側的 Delete/
     Duplicate——這是與本票 hover 穿透無關的既有版面問題（視窗夠寬或動
     畫按鈕不存在時不會發生），留給 Dev-Reviewer 判斷是否要另外開票；
     這裡换到第 1 頁（沒有動畫按鈕、情境列較窄）避開它，Delete 全程在
     可視範圍內。
"""

import time  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def wait_selection_chip(expected: str, timeout: float = 2.0) -> str:
    """`select()`/`selection()` 可能讀到呼叫當下尚未刷新的舊 chip（見
    `agent_helpers.py` 的 `_wait_chip_update` 說明：chip 已非空時立刻回）
    ——本檔自己對 `selection()["chip"]` 輪詢到符合預期或逾時，不信任
    `select()` 呼叫當下的回傳值。"""
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = selection()["chip"]  # noqa: F821
        if last == expected:
            return last
        time.sleep(0.05)
    return last


def main() -> int:
    open_deck()  # noqa: F821

    # A：第 3 頁，非 additive 點擊——「第一點」被選取後，「第二點」的位置
    # 落在情境列範圍內；base 上這一點命中的是情境列本身（`.context-bar-
    # item` 按鈕或空白處），選取維持在「第一點」不變；分支上情境列預設
    # 穿透，點擊落到 iframe，選取變成「第二點」。
    goto_slide(3)  # noqa: F821
    select("第一點")  # noqa: F821
    time.sleep(0.5)  # 讓情境列真的渲染、定位穩定，避免量到動畫中途的座標
    select("第二點")  # noqa: F821
    chip_a = wait_selection_chip("Selected: 第二點")
    check("A 非 additive 點擊穿透情境列，選到第二點", chip_a == "Selected: 第二點", chip_a)

    # B：同一頁重來，這次 additive（⇧點）——「第二點」一樣被情境列壓住，
    # base 上這一擊同樣落在情境列上，加選失敗（chip 停在「第一點」或變成
    # 別的東西，不會是「2 elements」）；分支上加選成功。
    goto_slide(3)  # noqa: F821
    select("第一點")  # noqa: F821
    time.sleep(0.5)
    select("第二點", additive=True)  # noqa: F821
    chip_b = wait_selection_chip("Selected: 2 elements")
    check("B additive（⇧點）穿透情境列，加選成 2 elements", chip_b == "Selected: 2 elements", chip_b)

    # C：回歸防線——情境列預設穿透不代表它自己的按鈕壞了。hover 到它自己
    # 的矩形中心，停留足夠時間（`hover()` 内建 sleep，見其 docstring 對
    # HOVER_SOLIDIFY_MS 的引用）solidify 後，Delete 真的能點到、真的刪掉
    # 元素。用第 1 頁（見檔頭說明：情境列在這裡不會寬到被 Chat 面板局部
    # 遮住）。
    goto_slide(1)  # noqa: F821
    select("標題")  # noqa: F821
    time.sleep(0.5)
    cb = context_bar()  # noqa: F821
    check("C 情境列存在且未 hover 時是 ghost（非 solid）", cb["present"] and not cb["solid"], cb)
    rect = cb["rect"]
    hover(rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)  # noqa: F821
    cb2 = context_bar()  # noqa: F821
    check("C hover 停留後轉為 solid", cb2["solid"] is True, cb2["solid"])

    before = slide_svg(1)  # noqa: F821
    click_at(*cb2["buttons"]["Delete"])  # noqa: F821
    time.sleep(0.3)
    after = slide_svg(1)  # noqa: F821
    check("C 點 Delete 真的刪掉選取元素（檔案不再含 el-title、位元組已變）", "el-title" not in after and after != before, after != before)
    check("C 無 console error", console_errors() == [], console_errors())  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
