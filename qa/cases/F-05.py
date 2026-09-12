"""F-05: after selecting an element, clicking the dark-gray stage backdrop
around the slide fails to clear the selection.

Depends on the sandboxed QA layer (`quick_start.sh --qa` boots the environment,
`qa/agent_helpers.py` provides the fixed primitives — see qa/README.md and the
notes in qa/cases/F-15.py). This file also uses `click_at_xy(x, y)` /
`js(expression)`, which are not Slidra-specific primitives but globals that
browser-use's core already provides (the agent_helpers.py module docstring
itself says "every top-level name not starting with '_' becomes a global...
the same way core helpers like js()/cdp() are"), used here to locate and click
the ring of `.canvas-area` minus `.stage` — the "dark-gray stage backdrop
around the slide" is exactly this DOM region, and
e2e/stage-navigation.test.ts's `gutterPoint()` already uses the same
coordinate formula:

    open_deck() / goto_slide(n) / select(name_or_id) / selection() /
    console_errors() / shot(name) / click_at_xy(x, y) / js(expression)

Repro (06-KEYBOARD_AND_GESTURES.md, "click empty space to deselect"): select
the title on page 1, then click a point on the stage backdrop — on base, the
selection box, handles, and context bar all stay put; after the fix they
should clear.
"""

import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def context_bar_present() -> bool:
    return bool(js("document.querySelector('.context-bar') != null"))  # noqa: F821


def wait_selection_cleared(timeout: float = 2.0) -> dict:
    deadline = time.time() + timeout
    last = selection()  # noqa: F821
    while time.time() < deadline and last["chip"] != "":
        time.sleep(0.05)
        last = selection()  # noqa: F821
    return last


def wait_context_bar_gone(timeout: float = 2.0) -> bool:
    """The context bar's `union` comes from one round trip of runtime
    postMessage (the selection command -> updateBoxes() -> a bounds event ->
    canvas.ts's overlayUnion -> a React re-render), which is one async hop
    more than the chip clearing (synchronous React state) — the two don't
    finish in the same tick, so after `wait_selection_cleared()` returns we
    still need to wait for this signal separately rather than assume both
    are already settled."""
    deadline = time.time() + timeout
    present = context_bar_present()
    while time.time() < deadline and present:
        time.sleep(0.05)
        present = context_bar_present()
    return present


def main() -> int:
    open_deck()  # noqa: F821
    # goto_slide() rebuilds the slide iframe (a new srcdoc), which also
    # resets any inline-editing state a previous browser-use call may have
    # left behind (e.g. F-02.py's last step doing a double-click edit
    # without exiting it) — the browser tab is shared across calls, so don't
    # assume a clean state.
    goto_slide(1)  # noqa: F821

    sel = select("Title")  # noqa: F821
    check("A-0 status bar shows a chip after selecting", sel["chip"] != "", sel["chip"])
    check("A-1 context bar is in the DOM after selecting", context_bar_present(), context_bar_present())

    # Stage backdrop: 10px inward from `.canvas-area`'s top-left corner —
    # inside `.canvas-area` but outside `.stage` (the slide itself), same as
    # e2e/stage-navigation.test.ts's `gutterPoint()`. Self-check once that
    # this point is really outside `.stage`; if the layout assumption is
    # wrong, bail immediately with a nonzero exit rather than keep going
    # (any PASS/FAIL after that would be untrustworthy).
    backdrop = js(  # noqa: F821
        "(()=>{const w=document.querySelector('.canvas-area');const s=document.querySelector('.stage');"
        "if(!w||!s)return null;const wr=w.getBoundingClientRect();const sr=s.getBoundingClientRect();"
        "const x=wr.x+10,y=wr.y+10;"
        "const insideStage=x>=sr.x&&x<=sr.x+sr.width&&y>=sr.y&&y<=sr.y+sr.height;"
        "return {x:x,y:y,insideStage:insideStage};})()"
    )
    if backdrop is None or backdrop.get("insideStage"):
        print(f"FAIL A-2 coordinate self-check: the backdrop point is only valid outside .stage, got {backdrop!r}")
        return 1
    print(f"PASS A-2 coordinate self-check: {backdrop!r}")

    click_at_xy(backdrop["x"], backdrop["y"])  # noqa: F821
    after = wait_selection_cleared()
    check("B-1 selection clears after clicking the stage backdrop", after["chip"] == "", after)
    bar_still_present = wait_context_bar_gone()
    check("B-2 context bar leaves the DOM after clicking the stage backdrop", not bar_still_present, bar_still_present)
    check("B-3 no console errors", console_errors() == [], console_errors())  # noqa: F821
    shot("F-05")  # noqa: F821

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes the stdin script via exec(code, globals()), so
# globals()['__name__'] is "browser_harness.run", never "__main__" — the
# `if __name__ == "__main__"` guard never fires (qa/README.md §2). Call
# main() unconditionally instead and let the exit code decide the caller's
# process exit status.
raise SystemExit(main())
