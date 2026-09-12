"""F-02: keyboard paging stops working after selecting a slide element.

Depends on the sandboxed QA layer (`quick_start.sh --qa` boots the environment,
`qa/agent_helpers.py` provides the fixed primitives — see qa/README.md and the
notes in qa/cases/F-15.py). This file also uses `press_key(key)`, which is not
a Slidra-specific primitive but one of the globals browser-use's core already
provides (the agent_helpers.py module docstring itself says "every top-level
name not starting with '_' becomes a global... the same way core helpers like
js()/cdp() are" — press_key falls in the same bucket as js/cdp, so
qa/agent_helpers.py doesn't need any change for this):

    open_deck() / goto_slide(n) / select(name_or_id) / active_element() /
    status_bar() / dblclick(x, y) / console_errors() / shot(name) /
    press_key(key)

Repro (06-KEYBOARD_AND_GESTURES.md documents ← → as previous/next page): select
the title on page 1 so `document.activeElement` lands inside the slide iframe,
then press → — on base this does nothing at all; after the fix it should
advance the page. The second part of the check verifies existing behavior that
must still hold: after entering inline edit mode via double-click, the arrow
keys move the text cursor, and neither base nor the fix branch should page in
that state.
"""

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()  # noqa: F821
    # Explicitly navigate to page 1 — `open_deck()` reuses an existing tab
    # without resetting the current page, so it may still be on whatever page
    # a previous browser-use call (e.g. smoke.py) left it on; don't assume
    # it starts on page 1.
    goto_slide(1)  # noqa: F821

    select("Title")  # noqa: F821
    ae = active_element()  # noqa: F821
    check("A-0 focus lands inside the slide iframe after clicking the title", ae.get("in_iframe") is True, ae)

    bar0 = status_bar()  # noqa: F821
    check("A-1 on page 1 before paging", "Slide 1 of 4" in bar0, bar0)

    press_key("ArrowRight")  # noqa: F821
    bar1 = status_bar()  # noqa: F821
    check("A-2 → advances to page 2", "Slide 2 of 4" in bar1, bar1)
    check("A-3 no console errors", console_errors() == [], console_errors())  # noqa: F821
    shot("F-02-A")  # noqa: F821

    # Inline editing: click once first (same approach as table.test.ts E8, to
    # avoid a race where the overlay hasn't finished mounting yet on cold
    # start), then double-click to enter text editing.
    sel = select("Title")  # noqa: F821 - now on page 2
    box = sel["box"]
    if box is None:
        print("FAIL B-0 select('Title') returned no selection box, can't compute double-click coordinates")
        return 1
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    dblclick(cx, cy)  # noqa: F821

    bar_before = status_bar()  # noqa: F821
    press_key("ArrowRight")  # noqa: F821
    bar_after = status_bar()  # noqa: F821
    check(
        "B-1 → does not page while inline editing (page number/status bar text unchanged)",
        bar_after == bar_before,
        {"before": bar_before, "after": bar_after},
    )
    check("B-2 no console errors", console_errors() == [], console_errors())  # noqa: F821
    shot("F-02-B")  # noqa: F821

    # Exit inline editing — this browser tab is shared across browser-use
    # calls, so don't leave it in an editing state for the next script (this
    # QA session once left this step out and it made the next script's
    # select() click miss its target).
    press_key("Escape")  # noqa: F821

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes the stdin script via exec(code, globals()), so
# globals()['__name__'] is "browser_harness.run", never "__main__" — the
# `if __name__ == "__main__"` guard never fires (qa/README.md §2). Call
# main() unconditionally instead and let the exit code decide the caller's
# process exit status.
raise SystemExit(main())
