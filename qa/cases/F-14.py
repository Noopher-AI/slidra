"""F-14：Animate › Object 卡片欄位被右欄邊界切掉（父票 NOOP-355 #287，
本票 NOOP-396）。

依賴沙箱 QA 層（`quick_start.sh --qa` 起環境，`qa/agent_helpers.py` 提供
下列固定原語，`browser_harness.helpers` 提供 `js(expression, target_id=None)`）
——這支腳本只用這個清單：

    open_deck() / goto_slide(n) / select(name_or_id) / js(expression)

demo 第 3 頁（`demo/slides/003.svg`）固定有 3 個 `slidra:effect`（第一點／
第二點／第三點，皆 enter/fade 或 appear），已用
`grep -c "slidra:effect " demo/slides/003.svg` 核對過。Animate › Object 的
卡片清單列的是「目前投影片的全部效果」，不是只列被選取的元素
（AnimateObjectPanel.tsx 的 `useSlideEffects`/`buildCards`），所以只要任
一元素被選取（讓右欄的 Object 子分頁從 disabled 變成可切換、並依
02-DESIGN_DOC.md §4.4 的自動切換規則切過去），三張卡片就會一次全部出現。

判準：1440×900 視窗下，三張卡片各自的 `.animate-card-fields`
`scrollWidth ≤ clientWidth`，且 Start 欄位的 `getBoundingClientRect().right
≤ 1440`（父票驗收條件原文）。
"""

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821
    select("第一點")  # noqa: F821 - 任一元素即可：只是為了讓 Object 子分頁從 disabled 變成可見

    js("document.querySelector('[role=\"tab\"][data-tab=\"animate\"]').click()")  # noqa: F821

    # React 的重繪不是同步跟著 click() 這行 js() 呼叫走的——object-animation.
    # test.ts 用 `expect.poll(() => objectCards(page).count()).toBe(1)` 等，
    # 這裡沒有等價的 poll 原語，改用一個寬鬆輪詢等卡片數量穩定出現。
    import time

    deadline = time.time() + 5.0
    card_count = 0
    while time.time() < deadline:
        card_count = js("document.querySelectorAll('.animate-object-list .animate-card').length")  # noqa: F821
        if card_count == 3:
            break
        time.sleep(0.2)

    cards = js(  # noqa: F821
        "(()=>{"
        "const cards=Array.from(document.querySelectorAll('.animate-object-list .animate-card'));"
        "return cards.map(card=>{"
        "const fields=card.querySelector('.animate-card-fields');"
        "const fieldsRect=fields?{scrollWidth:fields.scrollWidth,clientWidth:fields.clientWidth}:null;"
        "const startField=Array.from(card.querySelectorAll('.animate-card-field'))"
        ".find(f=>f.querySelector('span')?.textContent==='Start');"
        "const startSelect=startField?startField.querySelector('select'):null;"
        "const startRight=startSelect?startSelect.getBoundingClientRect().right:null;"
        "return {fieldsRect, startRight};"
        "});})()"
    )

    check("Animate › Object 清單顯示 3 張卡片", len(cards) == 3, len(cards))

    for i, card in enumerate(cards, start=1):
        fields_rect = card["fieldsRect"]
        check(
            f"卡片 {i}：.animate-card-fields scrollWidth ≤ clientWidth",
            fields_rect is not None and fields_rect["scrollWidth"] <= fields_rect["clientWidth"],
            fields_rect,
        )
        start_right = card["startRight"]
        check(
            f"卡片 {i}：Start 欄位 right ≤ 1440",
            start_right is not None and start_right <= 1440,
            start_right,
        )

    print(f"總結：{len(FAILURES)} 項失敗" if FAILURES else "總結：全數通過")
    return 1 if FAILURES else 0


raise SystemExit(main())
