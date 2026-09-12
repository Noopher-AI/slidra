"""F-08: text/rectangle/ellipse/line elements inserted from the Insert panel
should use a contrast color when the page has no accent set, instead of
falling back to the SVG default or the `--brand-red` design token
(documented in docs/visual-qa.md).

Depends on the sandboxed QA layer (`quick_start.sh --qa` boots the environment,
`qa/agent_helpers.py` provides the following fixed primitives):

    open_deck() / goto_slide(n) / slide_svg(n) / shot(name)

The dock's Text/Shape buttons and the Rectangle/Ellipse/Line items in the
Shape menu aren't covered by any existing high-level primitive — they're
ordinary DOM buttons in the parent document, not named in qa/README.md §3.5,
and outside the input-event race that only applies inside the slide's srcdoc
iframe. So this uses the core primitive `js()` that `browser_harness.helpers`
also injects (the `qa/agent_helpers.py` module docstring already names it,
alongside `cdp()`, as a global still available outside this layer) to
dispatch a plain DOM `element.click()`. The Text panel deliberately doesn't
type anything before clicking Insert — leaving it empty falls back to the
default placeholder text "Body text", which doesn't appear on either the demo
deck's or the blank deck's first page, so it can be used as a marker to
identify the newly inserted element without touching React's controlled
textarea synthetic events.

Judgment criteria: this case needs to run twice — once against the default
demo deck's page 1 (`quick_start.sh --qa`, background `#101418`, dark, no
accent), and once against the `--blank` blank deck (`quick_start.sh --qa
--blank`, a new deck's first page has no declared background/accent, which by
convention defaults to white). Both runs must pass: every newly inserted
element must carry an explicit fill (stroke for the line), with its lightness
in the opposite direction from the page background. On base (before the fix),
a rectangle/ellipse inserted on a dark page omits fill (falling through to
the SVG default black, nearly invisible on a dark page), text omits fill the
same way, and a line's stroke falls back to the `--brand-red` design token
instead of a contrast color — both the "every new element has an explicit
attribute" and "lightness is inverted" assertions fail on base for a dark
page.
"""

import re
import time

FAILURES: list[str] = []
MARKER = "Body text"


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _click_selector(selector: str) -> bool:
    """Dispatches one click() on the first element matching selector in the
    parent document (not the slide iframe). Returns whether an element was
    found."""
    expr = "(()=>{const el=document.querySelector(" + repr(selector) + ");if(!el)return false;el.click();return true;})()"
    return bool(js(expr))  # noqa: F821 - injected by browser-use


def _click_shape_item(label: str) -> bool:
    """Shape menu items (Rectangle/Ellipse/Line) have no dedicated
    class/attribute to querySelector directly, so match by text against
    `.shape-menu-item`."""
    expr = (
        "(()=>{const items=document.querySelectorAll('.shape-menu-item');"
        "for(const el of items){if(el.textContent.trim()===" + repr(label) + "){el.click();return true;}}"
        "return false;})()"
    )
    return bool(js(expr))  # noqa: F821


def _poll(predicate_js: str, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if js(predicate_js):  # noqa: F821
            return True
        time.sleep(0.1)
    return False


def _recover_stuck_runtime_ready(timeout: float = 5.0) -> bool:
    """This is a pre-existing defect in the QA infrastructure itself
    (`qa/agent_helpers.py`'s `open_deck()`), unrelated to this case or the
    contrast-color fix it's testing: `_ready_probe(mark_pending=navigated)`
    only attaches the parent-side `message` listener after `_wait_for_load()`
    returns, so if that navigation's slide iframe fires its one-shot,
    non-resent `runtime-ready` message before the listener is attached, that
    postMessage is lost forever and `window.__cmQaReady.pending` gets stuck
    at `true` — after that, any gesture that goes through `_dispatch_mouse`
    (`_click`/`drag`/`dblclick`, and therefore `goto_slide` and this case's
    `_click_selector`/`_click_shape_item` too) will time out in
    `_require_runtime_ready()`, even though the product itself (iframe fully
    loaded, `console_errors()` clean) is working fine. Reproducible on
    multiple commits independently.

    Local mitigation (only in this case script, not in
    `qa/agent_helpers.py`): use the core primitive `click_at_xy`
    (`browser_harness.helpers` itself, not Slidra's `_click`), which isn't
    gated by this check, to click the current page's own first thumbnail
    directly, forcing a real srcdoc rebuild after the listener is already in
    place, which clears the stuck pending flag — this works even with only
    one slide (`--blank`): clicking the same thumbnail repeatedly still
    triggers a fresh srcdoc swap each time. Returns whether it's unstuck (or
    was never stuck to begin with)."""
    info = js("(()=>((window.__cmQaReady||{}).pending))()")  # noqa: F821
    if not info:
        return True
    box = js(  # noqa: F821
        "(()=>{const el=document.querySelector('.overview-thumb');"
        "if(!el)return null;const r=el.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    if not box:
        return False
    click_at_xy(box["x"], box["y"])  # noqa: F821
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not js("(()=>((window.__cmQaReady||{}).pending))()"):  # noqa: F821
            return True
        time.sleep(0.2)
    return False


def _call_recovering_runtime_ready(fn, *args):
    """`fn` is any existing primitive call that ultimately goes through
    `_dispatch_mouse` (and is therefore gated by `_require_runtime_
    ready()`) — wrapping it here lets it retry once if it hits the
    pre-existing QA defect described in `_recover_stuck_runtime_ready`,
    instead of letting the whole case script abort on the exception."""
    try:
        return fn(*args)
    except RuntimeError as exc:
        if "runtime-ready" not in str(exc):
            raise
        if not _recover_stuck_runtime_ready():
            raise
        return fn(*args)


def _parse_hex(value: str) -> tuple[int, int, int]:
    """Only accepts `#rgb`/`#rrggbb` — this matches both `contrast-fill.ts`'s
    output and `page style set --accent`'s existing convention. Any other
    format is treated as an anomaly the assertion itself should report, not
    guessed at or swallowed."""
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6 or re.search(r"[^0-9a-fA-F]", v):
        raise ValueError(f"not a #rgb/#rrggbb color value: {value!r}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def _relative_luminance(r: int, g: int, b: int) -> float:
    """WCAG 2.x relative luminance — reimplemented independently from the
    same public formula as apps/web/src/contrast-fill.ts, not copied
    from its output as a reference answer."""

    def lin(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def _extract_attr(tag_markup: str, attr: str) -> str | None:
    m = re.search(attr + r'="([^"]*)"', tag_markup)
    return m.group(1) if m else None


def _find_text_open_tag(svg: str, marker: str) -> str | None:
    """The `<text>` content is wrapped in `<tspan>`s (`render_text_box_
    content`), so we can't just search for `<text ...>marker` directly —
    split into `</text>`-delimited blocks first, find the one containing the
    marker, then find its own opening tag within that block (each block has
    exactly one `<text ...>`)."""
    for block in svg.split("</text>"):
        if marker in block:
            m = re.search(r"<text\b[^>]*>", block)
            if m:
                return m.group(0)
    return None


def main() -> int:
    _call_recovering_runtime_ready(open_deck)  # noqa: F821
    _call_recovering_runtime_ready(goto_slide, 1)  # noqa: F821
    before = slide_svg(1)  # noqa: F821
    shot("F-08-before")  # noqa: F821

    check("precondition: the page has no accent set (this case only tests the no-accent branch)", "--slidra-accent" not in before, before[:200])
    check(
        "precondition: the page has no existing rect/ellipse/line elements (to avoid confusion with the newly inserted ones)",
        re.search(r"<(rect|ellipse|line)\b", before) is None,
        before[:300],
    )

    bg_match = re.search(r"background-color:\s*([^;\"]+)", before)
    background = bg_match.group(1).strip() if bg_match else None
    bg_luminance = _relative_luminance(*_parse_hex(background or "#ffffff"))
    page_is_dark = bg_luminance <= 0.5
    print(f"page background: {background!r}, luminance={bg_luminance:.4f}, judged {'dark' if page_is_dark else 'light'}")

    # --- insert text (Text panel, leave text empty and use the "Body text" placeholder as a marker) ---
    check("open the Text panel", _click_selector('.dock-command[aria-label="Text"]'), None)
    check("Text panel appears", _poll("!!document.querySelector('.text-panel-input')"), None)
    check("click the Text panel's Insert", _click_selector(".text-panel-insert"), None)
    check("Text panel closes (insert done)", _poll("!document.querySelector('.text-panel')"), None)

    # --- insert rectangle ---
    check("open the Shape menu (rectangle)", _click_selector('.dock-command[aria-label="Shape"]'), None)
    check("Shape menu appears (rectangle)", _poll("!!document.querySelector('.shape-menu')"), None)
    check("click Rectangle", _click_shape_item("Rectangle"), None)
    check("Shape menu closes (rectangle inserted)", _poll("!document.querySelector('.shape-menu')"), None)

    # --- insert ellipse ---
    check("open the Shape menu (ellipse)", _click_selector('.dock-command[aria-label="Shape"]'), None)
    check("Shape menu appears (ellipse)", _poll("!!document.querySelector('.shape-menu')"), None)
    check("click Ellipse", _click_shape_item("Ellipse"), None)
    check("Shape menu closes (ellipse inserted)", _poll("!document.querySelector('.shape-menu')"), None)

    # --- insert line ---
    check("open the Shape menu (line)", _click_selector('.dock-command[aria-label="Shape"]'), None)
    check("Shape menu appears (line)", _poll("!!document.querySelector('.shape-menu')"), None)
    check("click Line", _click_shape_item("Line"), None)
    check("Shape menu closes (line inserted)", _poll("!document.querySelector('.shape-menu')"), None)

    if FAILURES:
        print(f"Summary: {len(FAILURES)} failure(s) (setup steps incomplete, skipping attribute checks)")
        return 1

    after = slide_svg(1)  # noqa: F821
    shot("F-08-after")  # noqa: F821

    text_tag = _find_text_open_tag(after, MARKER)
    check("found the newly inserted text element", text_tag is not None, text_tag)
    text_fill = _extract_attr(text_tag, "fill") if text_tag else None
    check("text element has an explicit fill (not omitted, falling to SVG default black)", bool(text_fill), text_fill)

    rect_match = re.search(r"<rect\b[^>]*/?>", after)
    check("found the newly inserted rectangle element", rect_match is not None, None)
    rect_fill = _extract_attr(rect_match.group(0), "fill") if rect_match else None
    check("rectangle element has an explicit fill (not omitted, falling to SVG default black)", bool(rect_fill), rect_fill)

    ellipse_match = re.search(r"<ellipse\b[^>]*/?>", after)
    check("found the newly inserted ellipse element", ellipse_match is not None, None)
    ellipse_fill = _extract_attr(ellipse_match.group(0), "fill") if ellipse_match else None
    check("ellipse element has an explicit fill (not omitted, falling to SVG default black)", bool(ellipse_fill), ellipse_fill)

    line_match = re.search(r"<line\b[^>]*/?>", after)
    check("found the newly inserted line element", line_match is not None, None)
    line_stroke = _extract_attr(line_match.group(0), "stroke") if line_match else None
    check("line element has an explicit stroke (not falling back to the --brand-red design token)", bool(line_stroke), line_stroke)

    for label, value in (
        ("text fill", text_fill),
        ("rectangle fill", rect_fill),
        ("ellipse fill", ellipse_fill),
        ("line stroke", line_stroke),
    ):
        if not value:
            continue
        try:
            lum = _relative_luminance(*_parse_hex(value))
        except ValueError as exc:
            check(f"{label} lightness is inverted relative to the page background", False, str(exc))
            continue
        value_is_light = lum > 0.5
        check(
            f"{label} lightness is inverted relative to the page background (value luminance={lum:.4f}, page luminance={bg_luminance:.4f})",
            value_is_light == page_is_dark,
            value,
        )

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes the stdin script via exec(code, globals()), so
# globals()['__name__'] is "browser_harness.run", never "__main__" — the
# `if __name__ == "__main__"` guard never fires (qa/README.md §2). Call
# main() unconditionally instead and let the exit code decide the caller's
# process exit status.
raise SystemExit(main())
