"""F-04：就地編輯中 Enter 插入硬換行，編輯時立即可見、提交後兩個 tspan
（父票 [E5.T9]／NOOP-354，對應 GitHub #286；本案例對應 Execute 階段
NOOP-399）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列原語）——這支腳本只用這個清單，不新增原語、不改寫成別的 harness：

    open_deck() / goto_slide(n) / select(name_or_id) / active_element() /
    dblclick(x, y) / press(key) / type_text(text) / iframe_count(selector) /
    slide_svg(n)

`press`/`type_text`/`iframe_count` 是本輪新增（原本這個模組只有滑鼠手勢，
沒有任何打字用的原語，見這三個函式在 `qa/agent_helpers.py` 裡的 docstring）。

判準：demo 第 1 頁標題（`el-title`）是一個 plain `<text>`（沒有
`data-slidra-text-width`）。base 上，`applyTextEditContent` 對這種元素只做
`textEl.textContent = text`——SVG 原生不會對 "\\n" 換行，所以編輯中打
Enter 之後，畫面上 `#el-title` 底下仍然只有 1 個直接子 tspan（其實是 0
個，內容是純文字節點），要等 Esc 提交、SVG 端重新排版之後才看得到兩行。
分支上 `applyTextEditContent` 統一走 `renderTextBoxLines`，Enter 之後
「編輯中」畫面就已經是 2 個 tspan——這是 PR PASS、base FAIL 的判準來源。
"""

import re
import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _title_text_markup(svg: str) -> str:
    match = re.search(r'<g id="el-title"[^>]*>\s*(<text[^>]*>.*?</text>)', svg, re.S)
    if not match:
        raise RuntimeError("找不到 el-title 的 <text>")
    return match.group(1)


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
    before = slide_svg(1)  # noqa: F821
    check("前置：base 標題內容是「驗收用簡報」（尚未編輯）", "驗收用簡報" in _title_text_markup(before), before)

    sel = select("標題")  # noqa: F821
    box = sel["box"]
    if box is None:
        print("FAIL: select('標題')['box'] expected=not None actual=None")
        return 1
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    dblclick(cx, cy)  # noqa: F821

    ae = _poll(lambda: active_element(), lambda a: a.get("tag") == "TEXTAREA")  # noqa: F821
    check("雙擊標題後進入編輯（focus 落在就地編輯的 textarea）", ae.get("tag") == "TEXTAREA", ae)

    type_text("QA")  # noqa: F821
    press("Enter")  # noqa: F821
    type_text("X")  # noqa: F821

    tspan_count = iframe_count("#el-title text > tspan")  # noqa: F821
    check(
        "Esc 前：#el-title 的 <text> 直接子 tspan 已經是 2 個（換行編輯中就看得到，不必等提交）",
        tspan_count == 2,
        tspan_count,
    )

    press("Escape")  # noqa: F821

    after = _poll(lambda: slide_svg(1), lambda svg: "<tspan" in _title_text_markup(svg))  # noqa: F821
    title_markup = _title_text_markup(after)
    committed_tspan_count = title_markup.count("<tspan")
    check("Esc 後：slide_svg(1) 的 el-title 有 2 個 <tspan>（提交後真的寫進檔案）", committed_tspan_count == 2, title_markup)
    check("Esc 後：兩個 tspan 分別含打過的 QA／X", "QA" in title_markup and "X" in title_markup, title_markup)

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
