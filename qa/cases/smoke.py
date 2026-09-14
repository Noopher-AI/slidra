"""Smoke test for qa/agent_helpers.py — the helpers' own minimum guarantee,
not an assertion about product behavior. Run against the demo deck only:

    source .quickstart/qa/qa.env
    browser-use < qa/cases/smoke.py

setup() / act() / assert_() structure per qa/README.md. Exits 0 and prints
"PASS: smoke" when every primitive has been exercised and returned something
sane; otherwise prints "FAIL: <what> expected=<...> actual=<...>" and exits 1.
"""

import sys

_state = {}


def _fail(what, expected, actual):
    print(f"FAIL: {what} expected={expected!r} actual={actual!r}")
    sys.exit(1)


def setup():
    _state["deck"] = open_deck()  # noqa: F821 - injected by browser-use


def act():
    _state["slide_count"] = slide_count()  # noqa: F821
    _state["select_title"] = select("Title")  # noqa: F821
    _state["selection_after_select"] = selection()  # noqa: F821
    # active_element() only makes a claim about *this* moment — capture it
    # right after select(), before anything else moves focus elsewhere.
    _state["active_element"] = active_element()  # noqa: F821

    # drag()/dblclick() right here, on the same slide select() just landed
    # on — their (x, y) come from this selection's box, so they must run
    # before goto_slide() changes what's under those coordinates.
    box = _state["selection_after_select"]["box"]
    if box is not None:
        cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
        drag((cx, cy), (cx + 40, cy + 40))  # noqa: F821
        dblclick(cx, cy)  # noqa: F821
    _state["drag_dblclick_ok"] = True

    _state["slide_3"] = goto_slide(3)  # noqa: F821
    _state["status_bar_slide_3"] = status_bar()  # noqa: F821
    _state["svg_1"] = slide_svg(1)  # noqa: F821
    _state["save_state"] = save_state()  # noqa: F821
    _state["console_errors"] = console_errors()  # noqa: F821
    _state["shot_path"] = shot("smoke")  # noqa: F821


def assert_():
    if _state["deck"]["slides"] != 4:
        _fail("open_deck()['slides']", 4, _state["deck"]["slides"])
    if _state["slide_count"] != 4:
        _fail("slide_count()", 4, _state["slide_count"])

    chip = _state["select_title"]["chip"]
    if chip != "Selected: Title":
        _fail("select('Title')['chip']", "Selected: Title", chip)

    sel = _state["selection_after_select"]
    if sel["chip"] != "Selected: Title":
        _fail("selection()['chip']", "Selected: Title", sel["chip"])
    if sel["box"] is None:
        _fail("selection()['box']", "not None", None)
    handles = set(sel["handles"].keys())
    if not {"nw", "ne", "sw", "se"} <= handles:
        _fail("selection()['handles'] corners", "nw/ne/sw/se present", sorted(handles))

    if _state["slide_3"] != 3:
        _fail("goto_slide(3)", 3, _state["slide_3"])
    if "Slide 3 of 4" not in _state["status_bar_slide_3"]:
        _fail("status_bar() after goto_slide(3)", "contains 'Slide 3 of 4'", _state["status_bar_slide_3"])

    svg = _state["svg_1"]
    if not svg.startswith("<svg") or "viewBox" not in svg:
        _fail("slide_svg(1)", "starts with <svg and contains viewBox", svg[:80])

    save = _state["save_state"]
    if save.get("known") is not True:
        _fail("save_state()['known']", True, save.get("known"))
    # Not asserting dirty is False: smoke.py must be idempotent across
    # repeated runs, and the drag() above already dirties the deck on any
    # run after the first.

    ae = _state["active_element"]
    if ae.get("tag") != "IFRAME" and not ae.get("in_iframe"):
        _fail("active_element() after select()", "tag IFRAME or in_iframe True", ae)

    if not _state["drag_dblclick_ok"]:
        _fail("drag()/dblclick()", "no exception", "exception")
    # drag() not producing a visible move is not a failure here (this is a
    # known product defect covered by N-01; smoke only guarantees the
    # primitive itself doesn't raise and selection state is still readable
    # afterwards).
    if selection() is None:  # noqa: F821
        _fail("selection() after drag()/dblclick()", "a dict", None)

    if not isinstance(_state["console_errors"], list):
        _fail("console_errors()", "a list", _state["console_errors"])
    # Non-empty console_errors() is not a failure here — whether the app
    # currently logs console errors is outside this smoke test's scope.

    from pathlib import Path

    shot_path = Path(_state["shot_path"])
    if not shot_path.is_file() or shot_path.stat().st_size == 0:
        _fail("shot('smoke')", "existing file > 0 bytes", str(shot_path))


def main():
    setup()
    act()
    assert_()
    print("PASS: smoke")


# browser-use execs case scripts with `exec(code, globals())` against its own
# module globals (browser_harness.run) — __name__ there is never "__main__",
# so a `if __name__ == "__main__"` guard would silently never run. Call
# main() unconditionally instead.
main()
