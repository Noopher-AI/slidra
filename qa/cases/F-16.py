"""F-16: the animation-order badge blocks the resize handle.

Depends on the sandboxed QA layer (`scripts/quick_start.sh --qa` starts the environment,
`qa/agent_helpers.py` provides the fixed primitives below) -- this script only uses
this list, without adding new primitives or rewriting it against another harness:

    open_deck() / goto_slide(n) / select(name_or_id) / drag(from_xy, to_xy) /
    slide_svg(n) / console_errors()

**Status check against the fix already on main**: this bug has already been fixed on
main -- `.animation-badge`'s `pointer-events: none` was moved into
`stage-overlays.css`'s structural rule (`.stage-geometry, .stage-geometry * {
pointer-events: none !important }`), and `BadgeLayer` sits under that layer, so the
badge no longer blocks the handle; `e2e/object-animation.test.ts:520-568` already has
an e2e regression test for this same behavior, green on main. **This script is
therefore expected to PASS on both base and the branch** (an acceptance criterion
elsewhere saying "this ticket PASS, base FAIL" is a leftover from reusing an older
template, not the actual criterion here) -- it's kept only to round out the regression
case script called for by the ticket, so a PASS/PASS result here doesn't mean this
ticket did nothing; it means this part of F-16 simply isn't in this ticket's scope of
work.
"""

import re  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def font_size_of(svg: str, element_id: str) -> str | None:
    """The font-size value from `<g id="el-step-one">...<text ... font-size="40"
    .../></g>` -- uses the smallest workable regex to grab the first font-size
    within the same `<g>` block, without pulling in a full XML parser (all this
    script needs is "did it change")."""
    g_match = re.search(rf'<g id="{re.escape(element_id)}"[^>]*>(.*?)</g>', svg, re.S)
    if not g_match:
        return None
    fs_match = re.search(r'font-size="([^"]+)"', g_match.group(1))
    return fs_match.group(1) if fs_match else None


def main() -> int:
    open_deck()  # noqa: F821
    goto_slide(3)  # noqa: F821

    before = slide_svg(3)  # noqa: F821
    before_fs = font_size_of(before, "el-step-one")
    check("Setup: el-step-one has font-size=40 before resizing", before_fs == "40", before_fs)

    sel = select("第一點")  # noqa: F821
    nw = sel["handles"].get("nw")
    check("Setup: the top-left handle (nw) exists", nw is not None, sel["handles"])
    if nw is None:
        print("Summary: 1 failure (could not get handle coordinates, aborting)")
        return 1

    # Reproduction from the ticket: drag the top-left handle toward the top-left
    # by something like (611,312); the animation badge ① at (603,304)-(619,320)
    # sits right on top of this handle. The badge has since been moved to a
    # forced-pass-through geometry layer, so this drag should now work normally.
    drag(nw, (nw[0] - 40, nw[1] - 40))  # noqa: F821

    after = slide_svg(3)  # noqa: F821
    after_fs = font_size_of(after, "el-step-one")
    check("A el-step-one's font-size changes after dragging the top-left handle (resize took effect)", after_fs is not None and after_fs != before_fs, after_fs)
    check("B no console error", console_errors() == [], console_errors())  # noqa: F821

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use runs the stdin script via exec(code, globals()); globals()['__name__']
# is "browser_harness.run", never "__main__", so the `if __name__ == "__main__"` guard
# would never fire (qa/README.md §2). Call main() unconditionally instead and let
# the caller's process exit code carry the result.
raise SystemExit(main())
