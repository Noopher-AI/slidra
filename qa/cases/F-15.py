"""F-15: dragging on the true empty space below the three lines of text on demo
slide 3 should produce a marquee selection.

Depends on the sandboxed QA layer (`quick_start.sh --qa` starts the environment,
`qa/agent_helpers.py` provides the fixed primitives below) -- this script only uses
this list, without adding new primitives or rewriting it against another harness
(e.g. Playwright e2e):

    open_deck() / goto_slide(n) / select(name_or_id) / selection() /
    drag(from_xy, to_xy, steps=10) / slide_svg(n) / status_bar() /
    console_errors() / shot(name)

`qa/agent_helpers.py` was delivered earlier; the `selection()["box"]["x"/"y"]` usage
below was checked against that file's `selection()` docstring and the key names are
indeed `x`/`y`/`w`/`h`. The primitives are injected as globals by `browser-use` via
`exec(code, globals())` (see `qa/cases/smoke.py`) -- they aren't an importable
module, so this file calls them directly and adds `# noqa: F821` at each call site.

Criteria: demo slide 3 has a full-bleed background rect on base (el-WZX2BUPDpa8S,
hit by any point on the canvas), so "dragging on empty space" always resolves to a
move gesture on base -- it really moves this rect and writes the file. This change
removes that rect, so the same drag on the branch is a marquee gesture instead (since
the start point no longer hits any element) and doesn't write the file. "Did the file
bytes change" and "what the status bar reports as selected" are therefore necessarily
opposite between base and the branch, which is where the two independent groups of
assertions below come from.
"""

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821
    before = slide_svg(3)  # noqa: F821

    # Coordinate mapping: the three text lines' baselines in demo/slides/003.svg
    # are at y=300/390/480 (same font size, equal spacing). Use "bullet one" and
    # "bullet three" to derive the scale and origin from user-space to parent-
    # document coordinates, then self-check against "bullet two" -- if the mapping
    # is wrong, none of the later PASS/FAIL results can be trusted, so a failed
    # self-check aborts with a non-zero exit instead of continuing with the gestures.
    select("第一點")  # noqa: F821
    p1 = selection()["box"]  # noqa: F821
    goto_slide(3)  # noqa: F821
    select("第三點")  # noqa: F821
    p3 = selection()["box"]  # noqa: F821
    goto_slide(3)  # noqa: F821

    scale = (p3["y"] - p1["y"]) / (480 - 300)
    origin_x = p1["x"] - 640 * scale
    origin_y = p1["y"] - 300 * scale

    def to_page(x: float, y: float) -> tuple[float, float]:
        return origin_x + x * scale, origin_y + y * scale

    select("第二點")  # noqa: F821
    p2 = selection()["box"]  # noqa: F821
    goto_slide(3)  # noqa: F821
    expected_x, expected_y = to_page(640, 390)
    self_check_ok = abs(p2["x"] - expected_x) < 4 and abs(p2["y"] - expected_y) < 4
    if not self_check_ok:
        print(
            f"FAIL coordinate-mapping self-check: computed ({expected_x:.1f},{expected_y:.1f}), "
            f"measured bullet-two position ({p2['x']:.1f},{p2['y']:.1f})"
        )
        return 1
    print(f"PASS coordinate-mapping self-check: scale={scale:.4f}")

    # Gesture A (the gesture specified by the acceptance criteria): drag down and
    # to the right on the true empty space below the three lines of text.
    drag(to_page(200, 560), to_page(1080, 690), steps=10)  # noqa: F821
    after_a = slide_svg(3)  # noqa: F821
    bar_a = status_bar()  # noqa: F821
    check("A-1 file bytes unchanged (dragging on empty space doesn't write)", after_a == before, after_a == before)
    # status_bar() returns the whole footer's textContent, including keyboard-shortcut
    # hints and the page number (see qa/agent_helpers.py's docstring) -- these are
    # unrelated to selection state and always present, so "selection is empty" can't
    # be asserted as "the whole bar is an empty string" (that would always be False,
    # selection or not); use the same trick as B-2 instead: assert the selection
    # chip's text isn't in the bar.
    check("A-2 status bar selection is empty (the rect didn't hit any element)", "Selected:" not in bar_a, bar_a)
    check("A-3 no console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-15-A")  # noqa: F821

    goto_slide(3)  # noqa: F821 - clear the selection left over from gesture A so it doesn't pollute gesture B's assertions

    # Gesture B: a rectangle covering the three lines of text but not the title,
    # to verify the "number of hit elements" signal.
    drag(to_page(120, 230), to_page(1160, 700), steps=10)  # noqa: F821
    after_b = slide_svg(3)  # noqa: F821
    bar_b = status_bar()  # noqa: F821
    check("B-1 file bytes unchanged (dragging on empty space doesn't write)", after_b == before, after_b == before)
    check("B-2 status bar reports 3 elements hit", "Selected: 3 elements" in bar_b, bar_b)
    check("B-3 no console error", console_errors() == [], console_errors())  # noqa: F821
    shot("F-15-B")  # noqa: F821

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use runs the stdin script via exec(code, globals()); globals()['__name__']
# is "browser_harness.run", never "__main__", so the `if __name__ == "__main__"` guard
# would never fire (qa/README.md §2). Call main() unconditionally instead and let
# the caller's process exit code carry the result.
raise SystemExit(main())
