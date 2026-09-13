"""F-04: pressing Enter during inline text editing should insert a hard line
break, visible immediately while editing, and produce two tspans once
committed.

Depends on the sandboxed QA layer (`scripts/quick_start.sh --qa` boots the environment,
`qa/agent_helpers.py` provides the primitives below) — this script only uses
this list; it doesn't add new primitives or rewrite itself against a different
harness:

    open_deck() / goto_slide(n) / select(name_or_id) / active_element() /
    dblclick(x, y) / press(key) / type_text(text) / iframe_count(selector) /
    slide_svg(n)

`press`/`type_text`/`iframe_count` are new additions (this module previously
only had mouse-gesture primitives, nothing for typing — see these three
functions' docstrings in `qa/agent_helpers.py`).

Judgment criteria: on the demo, page 1's title (`el-title`) is a plain
`<text>` (no `data-slidra-text-width`). On base, `applyTextEditContent` for
this kind of element just does `textEl.textContent = text` — SVG doesn't
natively line-break on "\\n", so after typing Enter while editing, `#el-title`
still has only 1 direct child tspan on screen (actually 0 — the content is a
plain text node); the two lines only show up after Esc commits and the SVG
side re-lays it out. On the fix branch, `applyTextEditContent` always goes
through `renderTextBoxLines`, so right after Enter, while still editing, the
screen already shows 2 tspans — this is the criterion that makes the PR pass
and base fail.
"""

import re
import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _title_text_markup(svg: str) -> str:
    match = re.search(r'<g id="el-title"[^>]*>\s*(<text[^>]*>.*?</text>)', svg, re.S)
    if not match:
        raise RuntimeError("could not find el-title's <text>")
    return match.group(1)


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
    before = slide_svg(1)  # noqa: F821
    check("precondition: base title content is 'Acceptance Test Deck' (not yet edited)", "Acceptance Test Deck" in _title_text_markup(before), before)

    sel = select("Title")  # noqa: F821
    box = sel["box"]
    if box is None:
        print("FAIL: select('Title')['box'] expected=not None actual=None")
        return 1
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    dblclick(cx, cy)  # noqa: F821

    ae = _poll(lambda: active_element(), lambda a: a.get("tag") == "TEXTAREA")  # noqa: F821
    check("double-clicking the title enters edit mode (focus lands in the inline-edit textarea)", ae.get("tag") == "TEXTAREA", ae)

    type_text("QA")  # noqa: F821
    press("Enter")  # noqa: F821
    type_text("X")  # noqa: F821

    tspan_count = iframe_count("#el-title text > tspan")  # noqa: F821
    check(
        "before Esc: #el-title's <text> already has 2 direct child tspans (visible while still editing, no need to wait for commit)",
        tspan_count == 2,
        tspan_count,
    )

    press("Escape")  # noqa: F821

    after = _poll(lambda: slide_svg(1), lambda svg: "<tspan" in _title_text_markup(svg))  # noqa: F821
    title_markup = _title_text_markup(after)
    committed_tspan_count = title_markup.count("<tspan")
    check("after Esc: slide_svg(1)'s el-title has 2 <tspan>s (actually committed to the document)", committed_tspan_count == 2, title_markup)
    check("after Esc: the two tspans contain the typed QA / X respectively", "QA" in title_markup and "X" in title_markup, title_markup)

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes the stdin script via exec(code, globals()), so
# globals()['__name__'] is "browser_harness.run", never "__main__" — the
# `if __name__ == "__main__"` guard never fires (qa/README.md §2). Call
# main() unconditionally instead and let the exit code decide the caller's
# process exit status.
raise SystemExit(main())
