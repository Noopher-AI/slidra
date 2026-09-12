"""F-02：選取投影片元素後鍵盤換頁失效（父票 NOOP-385/NOOP-351，對應 GitHub #283）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供固定原
語——見 qa/README.md 與 qa/cases/F-15.py 的說明）。本檔額外用到的
`press_key(key)` 不是 comotion 專屬原語，是 browser-use 核心本來就有的全域
（agent_helpers.py 檔頭docstring 自己說「every top-level name not starting
with '_' becomes a global... the same way core helpers like js()/cdp() are」
——press_key 與 js/cdp 同一批，qa/agent_helpers.py 不需要為此改動）：

    open_deck() / goto_slide(n) / select(name_or_id) / active_element() /
    status_bar() / dblclick(x, y) / console_errors() / shot(name) /
    press_key(key)

重現（06-KEYBOARD_AND_GESTURES.md 明列 ← → 為上一頁／下一頁）：點第 1 頁標題
選取後，`document.activeElement` 落在投影片 iframe 內，這時按 → 在 base 上完
全不換頁；本票分支修好後應該換頁。第二段驗證的是本票同時要求維持的既有行
為——雙擊進入就地編輯後，方向鍵是游標移動，兩邊（base／分支）都不該換頁。
"""

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()  # noqa: F821
    # 明確導頁到第 1 頁——`open_deck()` 重用既有分頁時不會重設頁碼，殘留前一
    # 個 browser-use 呼叫（例如 smoke.py）留下的當前頁，不能假設從第 1 頁開始。
    goto_slide(1)  # noqa: F821

    select("標題")  # noqa: F821
    ae = active_element()  # noqa: F821
    check("A-0 點標題後焦點落在投影片 iframe 內", ae.get("in_iframe") is True, ae)

    bar0 = status_bar()  # noqa: F821
    check("A-1 換頁前在第 1 頁", "Slide 1 of 4" in bar0, bar0)

    press_key("ArrowRight")  # noqa: F821
    bar1 = status_bar()  # noqa: F821
    check("A-2 按 → 換到第 2 頁", "Slide 2 of 4" in bar1, bar1)
    check("A-3 無 console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-02-A")  # noqa: F821

    # 就地編輯：先點一下（同 table.test.ts E8 的既有作法，避開冷啟動時
    # overlay 尚未掛載完成的競態），再雙擊進入文字編輯。
    sel = select("標題")  # noqa: F821 - 目前在第 2 頁
    box = sel["box"]
    if box is None:
        print("FAIL B-0 select('標題') 沒有回傳選取框，無法算出雙擊座標")
        return 1
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    dblclick(cx, cy)  # noqa: F821

    bar_before = status_bar()  # noqa: F821
    press_key("ArrowRight")  # noqa: F821
    bar_after = status_bar()  # noqa: F821
    check(
        "B-1 就地編輯中按 → 不換頁（頁碼／狀態列文字不變）",
        bar_after == bar_before,
        {"before": bar_before, "after": bar_after},
    )
    check("B-2 無 console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-02-B")  # noqa: F821

    # 離開就地編輯——這個瀏覽器分頁跨 browser-use 呼叫共用，不留編輯中狀態
    # 給下一支腳本（同一個 QA session 曾經因為這裡漏收尾，讓下一支腳本的
    # select() 點擊落空）。
    press_key("Escape")  # noqa: F821

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
