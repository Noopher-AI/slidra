"""F-14: Animate › Object card fields get clipped by the right panel's edge.

Depends on the sandboxed QA layer (`scripts/quick_start.sh --qa` starts the environment,
`qa/agent_helpers.py` provides the fixed primitives below, `browser_harness.helpers`
provides `js(expression, target_id=None)`) -- this script only uses this list:

    open_deck() / goto_slide(n) / select(name_or_id) / js(expression)

Slide 3 of the demo (`demo/slides/003.svg`) always has 3 `slidra:effect` entries
(bullet one / bullet two / bullet three, each enter/fade or appear), verified with
`grep -c "slidra:effect " demo/slides/003.svg`. The Animate › Object card list shows
"all effects on the current slide", not just the ones on the selected element
(AnimateObjectPanel.tsx's `useSlideEffects`/`buildCards`), so as long as any element
is selected (which flips the right panel's Object sub-tab from disabled to switchable
and triggers the auto-switch rule from 02-DESIGN_DOC.md §4.4), all three cards appear
at once.

Criteria: at a 1440x900 viewport, each of the three cards' `.animate-card-fields` has
`scrollWidth <= clientWidth`, and the Start field's `getBoundingClientRect().right
<= 1440` (verbatim from the acceptance criteria).
"""

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821
    select("Point One")  # noqa: F821 - any element works: this is just to flip the Object sub-tab into view

    js("document.querySelector('[role=\"tab\"][data-tab=\"animate\"]').click()")  # noqa: F821

    # React's re-render isn't synchronous with this click() call inside js() --
    # object-animation.test.ts waits with `expect.poll(() => objectCards(page).count()).toBe(1)`,
    # but there's no equivalent poll primitive here, so use a loose poll for the
    # card count to settle instead.
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

    check("Animate › Object list shows 3 cards", len(cards) == 3, len(cards))

    for i, card in enumerate(cards, start=1):
        fields_rect = card["fieldsRect"]
        check(
            f"Card {i}: .animate-card-fields scrollWidth <= clientWidth",
            fields_rect is not None and fields_rect["scrollWidth"] <= fields_rect["clientWidth"],
            fields_rect,
        )
        start_right = card["startRight"]
        check(
            f"Card {i}: Start field right <= 1440",
            start_right is not None and start_right <= 1440,
            start_right,
        )

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


raise SystemExit(main())
