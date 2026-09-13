"""N-03: no double-click inside the slide iframe should ever produce
visible text selection.

Depends on the sandbox QA layer (`scripts/quick_start.sh --qa` brings up the
environment; `qa/agent_helpers.py` provides the following primitives) —
this script only uses this list; it doesn't add new primitives or switch
to a different harness:

    open_deck() / goto_slide(n) / select(name_or_id) / click_ui(selector) /
    click_at(x, y) / cell_box(row, col) / dblclick(x, y) / active_element() /
    press(key) / iframe_selection_text() / edit_textarea_user_select() /
    slide_svg(n)

`click_ui`/`click_at`/`cell_box`/`press`/`iframe_selection_text`/
`edit_textarea_user_select` are new in this round (the demo's four slides
have no table, and there was previously no primitive to check the slide
iframe's native text-selection state at all).

Rationale (qa/README.md §4, "how to write around an intermittent defect" —
N-03 itself is that section's worked example): the original repro is
intermittent (about 1 in 10), so the case script isn't required to
reproduce it. Instead it's written defensively: regardless of whether a
double-click happens to flash a text selection, `window.getSelection()`
inside the slide iframe should never come back non-empty. This case is
only required to PASS on the PR branch (an accepted exemption; it isn't
re-run against base).
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

    # Insert a 3x4 table from Dock > Table (matches e2e/table.test.ts's E1
    # step / the acceptance criterion's "insert a 3x4 table on slide 3").
    click_ui('button[aria-label="Table"]')  # noqa: F821
    click_ui('.table-panel-cell[aria-label="3 × 4"]')  # noqa: F821
    click_ui(".table-panel-insert")  # noqa: F821

    box11 = _poll(lambda: cell_box(1, 1), lambda b: b is not None)  # noqa: F821
    if box11 is None:
        print("FAIL: cell_box(1, 1) expected=not None actual=None (table failed to insert)")
        return 1
    cell_x, cell_y = box11["x"] + box11["width"] / 2, box11["y"] + box11["height"] / 2

    # Click once before double-clicking (same cold-start race as
    # e2e/table.test.ts's E8, and as F-09.py).
    click_at(cell_x, cell_y)  # noqa: F821

    for i in range(10):
        dblclick(cell_x, cell_y)  # noqa: F821
        sel = iframe_selection_text()  # noqa: F821
        check(f"double-click cell #{i + 1}: getSelection() inside the iframe is empty", sel == "", sel)
        ae = _poll(  # noqa: F821
            lambda: active_element(),
            lambda a: a.get("tag") == "INPUT" and "table-cell-editor" in (a.get("class") or ""),
        )
        check(
            f"double-click cell #{i + 1}: INPUT.table-cell-editor still opens as normal (the defensive fix doesn't block a normal double-click)",
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
        check(f"double-click slide text #{i + 1}: getSelection() inside the iframe is empty", sel == "", sel)
        press("Escape")  # noqa: F821

    # The in-place edit textarea is deliberately excluded from
    # user-select:none — it's the IME input target for typing, and a
    # double-click there still needs to select text. Enter edit mode once
    # more and check its computed style.
    dblclick(plain_x, plain_y)  # noqa: F821
    user_select = _poll(lambda: edit_textarea_user_select(), lambda v: v is not None)  # noqa: F821
    check("the in-place edit textarea's computed user-select is still text (double-click can still select text)", user_select == "text", user_select)
    press("Escape")  # noqa: F821

    print(f"Summary: {len(FAILURES)} failed" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes stdin scripts with exec(code, globals()), where
# globals()['__name__'] is "browser_harness.run" — never "__main__", so an
# `if __name__ == "__main__"` guard would never trigger (qa/README.md §2).
# Call unconditionally instead, and let the exit code decide the caller's
# process exit status.
raise SystemExit(main())
