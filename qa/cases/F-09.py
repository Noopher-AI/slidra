"""F-09: pressing Tab while editing a table cell should jump to the next
cell, with focus staying on the same `INPUT.table-cell-editor`.

Depends on the sandboxed QA layer (`quick_start.sh --qa` boots the environment,
`qa/agent_helpers.py` provides the following primitives) — this script only
uses this list; it doesn't add new primitives or rewrite itself against a
different harness:

    open_deck() / goto_slide(n) / click_ui(selector) / click_at(x, y) /
    cell_box(row, col) / dblclick(x, y) / active_element() / press(key) /
    type_text(text) / slide_svg(n)

`click_ui`/`click_at`/`cell_box`/`press`/`type_text` are new additions (the
demo's four pages have no table, so one has to be inserted first via Dock >
Table — following e2e/table.test.ts's E1 steps; `qa/agent_helpers.py` also
had no typing primitives before this).

Judgment criteria: on base, `TableOverlay.tsx`'s cell-editor `<input>` doesn't
handle Tab at all and falls through to the browser's default behavior —
focus leaves the input and lands on the dock's hand-tool button
(`BUTTON.dock-hand-button`), and whatever is typed after Tab goes nowhere. On
the fix branch, Tab is intercepted: the current cell is committed first, then
editing switches to the next cell, deliberately without unmounting/
remounting through a `setEditing(null)` intermediate state — focus stays on
the same `INPUT.table-cell-editor` throughout. The pass/fail criterion is
simply whether `active_element()` after Tab is still that same input.
"""

import re
import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _cell_markup(svg: str, row: int, col: int) -> str:
    match = re.search(rf'<g data-slidra-cell="{row},{col}"[^>]*>.*?</g>', svg, re.S)
    if not match:
        raise RuntimeError(f"could not find cell ({row},{col})")
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

    # Insert a 3x4 table from Dock > Table (following e2e/table.test.ts's E1
    # steps) — the demo's four pages have no table, and Tab-jumping needs a
    # cell to jump to.
    click_ui('button[aria-label="Table"]')  # noqa: F821
    click_ui('.table-panel-cell[aria-label="3 × 4"]')  # noqa: F821
    click_ui(".table-panel-insert")  # noqa: F821

    box00 = _poll(lambda: cell_box(0, 0), lambda b: b is not None)  # noqa: F821
    if box00 is None:
        print("FAIL: cell_box(0, 0) expected=not None actual=None (table failed to insert)")
        return 1

    # Click once before double-clicking — for a table that's never been
    # selected before, the first double-click can race with TableOverlay's
    # own mount effect (e2e/table.test.ts E8's comment already documents
    # this; it's not a defect in the Tab behavior itself).
    click_at(box00["x"] + box00["width"] / 2, box00["y"] + box00["height"] / 2)  # noqa: F821
    dblclick(box00["x"] + box00["width"] / 2, box00["y"] + box00["height"] / 2)  # noqa: F821

    ae = _poll(  # noqa: F821
        lambda: active_element(),
        lambda a: a.get("tag") == "INPUT" and "table-cell-editor" in (a.get("class") or ""),
    )
    check("double-clicking (0,0) enters edit mode: active_element() is INPUT.table-cell-editor", ae.get("tag") == "INPUT" and "table-cell-editor" in (ae.get("class") or ""), ae)

    type_text("A1")  # noqa: F821
    press("Tab")  # noqa: F821

    ae_after_tab = _poll(  # noqa: F821
        lambda: active_element(),
        lambda a: a.get("tag") == "INPUT" and "table-cell-editor" in (a.get("class") or ""),
    )
    check(
        "after Tab: active_element() is still INPUT.table-cell-editor (didn't land on the dock's hand-tool button)",
        ae_after_tab.get("tag") == "INPUT" and "table-cell-editor" in (ae_after_tab.get("class") or ""),
        ae_after_tab,
    )
    check("after Tab: focus is not inside the iframe (the cell-editor input is drawn in the parent document's overlay)", ae_after_tab.get("in_iframe") is False, ae_after_tab)

    type_text("B1")  # noqa: F821
    press("Enter")  # noqa: F821

    after = _poll(  # noqa: F821
        lambda: slide_svg(1),
        lambda svg: ">A1<" in svg and ">B1<" in svg,
    )
    check("after commit: slide_svg(1) reads back (0,0)=A1", ">A1<" in _cell_markup(after, 0, 0), _cell_markup(after, 0, 0))
    check("after commit: slide_svg(1) reads back (0,1)=B1 (what was typed after Tab actually landed in the next cell)", ">B1<" in _cell_markup(after, 0, 1), _cell_markup(after, 0, 1))

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes the stdin script via exec(code, globals()), so
# globals()['__name__'] is "browser_harness.run", never "__main__" — the
# `if __name__ == "__main__"` guard never fires (qa/README.md §2). Call
# main() unconditionally instead and let the exit code decide the caller's
# process exit status.
raise SystemExit(main())
