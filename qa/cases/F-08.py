"""F-08：Insert 面板插入的文字／矩形／橢圓／線條，在頁面沒有 accent 時要用
對比色（NOOP-353 拍板決定 7，父票 GitHub #285／#252），不是 SVG 預設或
`--brand-red` 設計 token 後備色（docs/visual-qa.md #133 就是這個缺陷）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語）：

    open_deck() / goto_slide(n) / slide_svg(n) / shot(name)

dock 的 Text/Shape 按鈕與 Shape 選單的 Rectangle/Ellipse/Line 項目沒有現成
的高階原語涵蓋——它們是父文件裡的一般 DOM 按鈕，不在 qa/README.md §3.5
點名、只發生在投影片 srcdoc iframe 裡的輸入事件競態範圍內，所以改用
`browser_harness.helpers` 本身也會注入的核心原語 `js()`（`qa/agent_
helpers.py` 模組 docstring 已點名它與 `cdp()` 是這一層之外仍然可用的
全域名稱）派送一般 DOM `element.click()`。Text 面板刻意不打字直接按
Insert——留空會用 `body` 預設的 placeholder 文字「Body text」，demo 與
空白簡報的第一頁都不含這個字串，拿來當新插入元素的識別標記，不必碰
React 受控 textarea 的合成事件。

判準：本案例要跑兩次——一次對著預設 demo deck 的第 1 頁（`quick_start.sh
--qa`，背景 `#101418`，深色，無 accent），一次對著 `--blank` 的空白簡報
（`quick_start.sh --qa --blank`，新簡報第一頁沒有宣告 background／accent，
依決定當白色）。兩次都要 PASS：每個新插入的元素都要帶明確的 fill（線條
是 stroke），且亮度方向與頁面背景相反。base（修復前）在深色頁插入的矩形
／橢圓會省略 fill（掉到 SVG 預設黑，在深色頁幾乎看不見），文字同樣省略
fill，線條的 stroke 落到 `--brand-red` 設計 token 而非對比色——「每個新
元素都帶明確屬性」與「亮度方向相反」兩條斷言在深色頁的 base 上會失敗。
"""

import re
import time

FAILURES: list[str] = []
MARKER = "Body text"


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _click_selector(selector: str) -> bool:
    """在父文件（非投影片 iframe）對第一個符合 selector 的元素送出一次
    click()。回傳是否找到元素。"""
    expr = "(()=>{const el=document.querySelector(" + repr(selector) + ");if(!el)return false;el.click();return true;})()"
    return bool(js(expr))  # noqa: F821 - injected by browser-use


def _click_shape_item(label: str) -> bool:
    """Shape 選單項目（Rectangle/Ellipse/Line）沒有各自的 class/attr 可以
    直接 querySelector 命中，用文字比對 `.shape-menu-item`。"""
    expr = (
        "(()=>{const items=document.querySelectorAll('.shape-menu-item');"
        "for(const el of items){if(el.textContent.trim()===" + repr(label) + "){el.click();return true;}}"
        "return false;})()"
    )
    return bool(js(expr))  # noqa: F821


def _poll(predicate_js: str, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if js(predicate_js):  # noqa: F821
            return True
        time.sleep(0.1)
    return False


def _parse_hex(value: str) -> tuple[int, int, int]:
    """只接受 `#rgb`/`#rrggbb`——`contrast-fill.ts` 輸出、`page style set
    --accent` 的既有慣例都是這個格式。其他格式視為斷言本身要回報的異常，
    不猜測、不吞掉。"""
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6 or re.search(r"[^0-9a-fA-F]", v):
        raise ValueError(f"不是 #rgb/#rrggbb 格式的顏色值：{value!r}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def _relative_luminance(r: int, g: int, b: int) -> float:
    """WCAG 2.x relative luminance——獨立於 packages/web/src/contrast-
    fill.ts 依同一個公開公式重新實作，不是抄實作的輸出當標準答案。"""

    def lin(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def _extract_attr(tag_markup: str, attr: str) -> str | None:
    m = re.search(attr + r'="([^"]*)"', tag_markup)
    return m.group(1) if m else None


def _find_text_open_tag(svg: str, marker: str) -> str | None:
    """`<text>` 內容是 `<tspan>` 包住的（`render_text_box_content`），所以
    不能直接找 `<text ...>marker`——先切成一個個 `</text>` 區塊，找含
    marker 的那一塊，再在那一塊裡找它自己的開頭標籤（每塊只會有一個
    `<text ...>`）。"""
    for block in svg.split("</text>"):
        if marker in block:
            m = re.search(r"<text\b[^>]*>", block)
            if m:
                return m.group(0)
    return None


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(1)  # noqa: F821
    before = slide_svg(1)  # noqa: F821
    shot("F-08-before")  # noqa: F821

    check("前置：頁面沒有設定 accent（本案例只驗證沒有 accent 的分支）", "--comot-accent" not in before, before[:200])
    check(
        "前置：頁面尚無既有的 rect/ellipse/line 元素（避免與新插入的元素混淆）",
        re.search(r"<(rect|ellipse|line)\b", before) is None,
        before[:300],
    )

    bg_match = re.search(r"background-color:\s*([^;\"]+)", before)
    background = bg_match.group(1).strip() if bg_match else None
    bg_luminance = _relative_luminance(*_parse_hex(background or "#ffffff"))
    page_is_dark = bg_luminance <= 0.5
    print(f"頁面背景：{background!r}，luminance={bg_luminance:.4f}，判定為{'深色' if page_is_dark else '淺色'}頁")

    # --- 插入文字（Text 面板，留空文字用 "Body text" 佔位字串當標記） ---
    check("開啟 Text 面板", _click_selector('.dock-command[aria-label="Text"]'), None)
    check("Text 面板出現", _poll("!!document.querySelector('.text-panel-input')"), None)
    check("點擊 Text 面板的 Insert", _click_selector(".text-panel-insert"), None)
    check("Text 面板關閉（插入完成）", _poll("!document.querySelector('.text-panel')"), None)

    # --- 插入矩形 ---
    check("開啟 Shape 選單（矩形）", _click_selector('.dock-command[aria-label="Shape"]'), None)
    check("Shape 選單出現（矩形）", _poll("!!document.querySelector('.shape-menu')"), None)
    check("點擊 Rectangle", _click_shape_item("Rectangle"), None)
    check("Shape 選單關閉（矩形插入完成）", _poll("!document.querySelector('.shape-menu')"), None)

    # --- 插入橢圓 ---
    check("開啟 Shape 選單（橢圓）", _click_selector('.dock-command[aria-label="Shape"]'), None)
    check("Shape 選單出現（橢圓）", _poll("!!document.querySelector('.shape-menu')"), None)
    check("點擊 Ellipse", _click_shape_item("Ellipse"), None)
    check("Shape 選單關閉（橢圓插入完成）", _poll("!document.querySelector('.shape-menu')"), None)

    # --- 插入線條 ---
    check("開啟 Shape 選單（線條）", _click_selector('.dock-command[aria-label="Shape"]'), None)
    check("Shape 選單出現（線條）", _poll("!!document.querySelector('.shape-menu')"), None)
    check("點擊 Line", _click_shape_item("Line"), None)
    check("Shape 選單關閉（線條插入完成）", _poll("!document.querySelector('.shape-menu')"), None)

    if FAILURES:
        print(f"總結：{len(FAILURES)} 項失敗（前置動作未完成，跳過屬性檢查）")
        return 1

    after = slide_svg(1)  # noqa: F821
    shot("F-08-after")  # noqa: F821

    text_tag = _find_text_open_tag(after, MARKER)
    check("找到新插入的文字元素", text_tag is not None, text_tag)
    text_fill = _extract_attr(text_tag, "fill") if text_tag else None
    check("文字元素帶明確 fill（不是省略、落到 SVG 預設黑）", bool(text_fill), text_fill)

    rect_match = re.search(r"<rect\b[^>]*/?>", after)
    check("找到新插入的矩形元素", rect_match is not None, None)
    rect_fill = _extract_attr(rect_match.group(0), "fill") if rect_match else None
    check("矩形元素帶明確 fill（不是省略、落到 SVG 預設黑）", bool(rect_fill), rect_fill)

    ellipse_match = re.search(r"<ellipse\b[^>]*/?>", after)
    check("找到新插入的橢圓元素", ellipse_match is not None, None)
    ellipse_fill = _extract_attr(ellipse_match.group(0), "fill") if ellipse_match else None
    check("橢圓元素帶明確 fill（不是省略、落到 SVG 預設黑）", bool(ellipse_fill), ellipse_fill)

    line_match = re.search(r"<line\b[^>]*/?>", after)
    check("找到新插入的線條元素", line_match is not None, None)
    line_stroke = _extract_attr(line_match.group(0), "stroke") if line_match else None
    check("線條元素帶明確 stroke（不是落到 --brand-red 設計 token）", bool(line_stroke), line_stroke)

    for label, value in (
        ("文字 fill", text_fill),
        ("矩形 fill", rect_fill),
        ("橢圓 fill", ellipse_fill),
        ("線條 stroke", line_stroke),
    ):
        if not value:
            continue
        try:
            lum = _relative_luminance(*_parse_hex(value))
        except ValueError as exc:
            check(f"{label} 亮度方向與頁面背景相反", False, str(exc))
            continue
        value_is_light = lum > 0.5
        check(
            f"{label} 亮度方向與頁面背景相反（值 luminance={lum:.4f}，頁面 luminance={bg_luminance:.4f}）",
            value_is_light == page_is_dark,
            value,
        )

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


# browser-use 用 exec(code, globals()) 執行 stdin 腳本，globals()['__name__']
# 是 "browser_harness.run"，永遠不是 "__main__"，`if __name__ == "__main__"`
# guard 永遠不會觸發（qa/README.md §2）。改為無條件呼叫，離開碼交給呼叫端
# 的行程退出碼決定。
raise SystemExit(main())
