"""F-17: the context bar blocks clickable content on the line below it.

Depends on the sandboxed QA layer (`scripts/quick_start.sh --qa` starts the environment,
`qa/agent_helpers.py` provides the fixed primitives below) -- this script only uses
this list, without adding new primitives or rewriting it against another harness:

    open_deck() / goto_slide(n) / select(name_or_id, additive=False) /
    selection() / hover(x, y) / click_at(x, y, shift=False) / context_bar() /
    slide_svg(n) / console_errors()

`select`/`hover`/`click_at`/`context_bar`, and `select`'s `additive` kwarg, were added
for this ticket (see the corresponding docstrings in `qa/agent_helpers.py`).

Criteria: on base, both A and B fail (the click gets blocked by the context bar, so
selection stays unchanged or the additive selection fails); on the branch, both pass;
C is a regression guard (Delete is still clickable after hover) and should pass on
both sides.

Two corrections made while reproducing the reported scenario (see A/B below for the
reasoning behind each):
  1. The scenario as originally reported was "slide 1, title -> subtitle", which
     seemed hard to reproduce at first, so slide 3's "bullet one -> bullet two" was
     used instead. A closer remeasurement at 1440x900 found: after selecting the
     title, the context bar sits at (442,378)-(1092,414), and the subtitle's box is
     at y 394.25-419.25 -- the two overlap by 23.6px, and the subtitle's center point
     (656,406.8) does hit `BUTTON.context-bar-item` via `elementFromPoint` on base,
     with the click landing on the title instead of moving selection to the subtitle.
     So the originally reported scenario does reproduce after all (the "roughly 3px
     gap" mentioned earlier was measured against the row that ends up below the
     subtitle once it's selected, not this scenario). A0 below restores that original
     slide-1 scenario verbatim, and slide 3's "bullet one -> bullet two" case (A) is
     kept as well, since `elementFromPoint` confirms the same thing there too --
     bullet two's center hits a `<button class="context-bar-item">` -- making it a
     second instance of the same defect on a bulleted layout.
  2. Section C (clicking Delete after hover) is deliberately kept on slide 1 rather
     than slide 3: slide 3's context bar is wider (764px) because of its extra Edit
     animation button, and at a 1440px-wide viewport it gets partially covered by the
     Chat panel on the right (starting around x=1101), hiding Delete/Duplicate at the
     far right -- an unrelated pre-existing layout issue (it doesn't happen with a
     wider viewport or without the animation button), left for a separate ticket if
     needed. Using slide 1 instead (no animation button, narrower context bar) avoids
     it, keeping Delete fully in view throughout.
"""

import time  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def wait_selection_chip(expected: str, timeout: float = 2.0) -> str:
    """`select()`/`selection()` may read a chip that hasn't refreshed yet at call
    time (see `agent_helpers.py`'s `_wait_chip_update`: it returns as soon as the
    chip is non-empty) -- so this file polls `selection()["chip"]` itself until it
    matches or times out, rather than trusting `select()`'s return value directly."""
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

    # A0 (the acceptance criteria's original scenario, restored verbatim): slide 1,
    # click the subtitle's coordinates right after selecting the title. Remeasured
    # at 1440x900 right after `select("標題")`: the context bar sits at
    # (442,378)-(1092,414), the subtitle's box is at y 394.25-419.25, overlapping by
    # 23.6px on the y axis; the subtitle's center point (656,406.8) hits a
    # `BUTTON.context-bar-item` via `elementFromPoint` on base -- so the reported
    # scenario does reproduce with the current demo content (the "roughly 3px gap"
    # mentioned earlier was measured against the row that appears below the subtitle
    # once it's already selected, not this scenario).
    goto_slide(1)  # noqa: F821
    select("標題")  # noqa: F821
    time.sleep(0.5)  # let the context bar actually render and settle before measuring, to avoid mid-animation coordinates
    select("副標")  # noqa: F821
    chip_a0 = wait_selection_chip("Selected: 副標")
    check("A0 slide 1: clicking the subtitle's coordinates right after selecting the title moves selection to the subtitle", chip_a0 == "Selected: 副標", chip_a0)

    # A: slide 3, non-additive click -- with "bullet one" selected, "bullet two"'s
    # position falls within the context bar's bounds; on base this click hits the
    # context bar itself (a `.context-bar-item` button or empty space within it) and
    # selection stays on "bullet one"; on the branch the context bar passes clicks
    # through by default, so the click reaches the iframe and selection moves to
    # "bullet two".
    goto_slide(3)  # noqa: F821
    select("第一點")  # noqa: F821
    time.sleep(0.5)  # let the context bar actually render and settle before measuring, to avoid mid-animation coordinates
    select("第二點")  # noqa: F821
    chip_a = wait_selection_chip("Selected: 第二點")
    check("A non-additive click passes through the context bar and selects bullet two", chip_a == "Selected: 第二點", chip_a)

    # B: same slide again, this time additive (shift-click) -- "bullet two" is
    # likewise covered by the context bar; on base this click lands on the context
    # bar too, so the additive selection fails (the chip stays on "bullet one" or
    # turns into something else, never "2 elements"); on the branch the additive
    # selection succeeds.
    goto_slide(3)  # noqa: F821
    select("第一點")  # noqa: F821
    time.sleep(0.5)
    select("第二點", additive=True)  # noqa: F821
    chip_b = wait_selection_chip("Selected: 2 elements")
    check("B additive (shift-click) passes through the context bar and adds to selection ('2 elements')", chip_b == "Selected: 2 elements", chip_b)

    # C: regression guard -- the context bar passing through clicks by default
    # doesn't mean its own buttons are broken. After hovering over its own rectangle
    # long enough (`hover()` has a built-in sleep, see its docstring's reference to
    # HOVER_SOLIDIFY_MS) to solidify, Delete should really be clickable and really
    # delete the element. Uses slide 1 (see the note above: its context bar isn't
    # wide enough to get partially covered by the Chat panel).
    goto_slide(1)  # noqa: F821
    select("標題")  # noqa: F821
    time.sleep(0.5)
    cb = context_bar()  # noqa: F821
    check("C context bar exists and is a ghost (not solid) before hover", cb["present"] and not cb["solid"], cb)
    rect = cb["rect"]
    hover(rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)  # noqa: F821
    cb2 = context_bar()  # noqa: F821
    check("C turns solid after hovering long enough", cb2["solid"] is True, cb2["solid"])

    before = slide_svg(1)  # noqa: F821
    click_at(*cb2["buttons"]["Delete"])  # noqa: F821
    time.sleep(0.3)
    after = slide_svg(1)  # noqa: F821
    check("C clicking Delete really removes the selected element (el-title is gone, bytes changed)", "el-title" not in after and after != before, after != before)
    check("C no console error", console_errors() == [], console_errors())  # noqa: F821

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use runs the stdin script via exec(code, globals()); globals()['__name__']
# is "browser_harness.run", never "__main__", so the `if __name__ == "__main__"` guard
# would never fire (qa/README.md §2). Call main() unconditionally instead and let
# the caller's process exit code carry the result.
raise SystemExit(main())
