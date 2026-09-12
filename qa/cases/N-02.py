"""N-02: thumbnail right-click "Save as template" entry point.

The fixed primitives used by `qa/cases/F-15.py` (open_deck()/goto_slide()/
select()/selection()/drag()/slide_svg()/status_bar()/console_errors()/
shot()) are the interface `qa/agent_helpers.py` provides for "slide canvas
gestures". The three UI surfaces this case needs to drive — the thumbnail
context menu, the Save as template dialog, and the New panel's Layouts
list — all live in the ordinary parent-document DOM outside the canvas
iframe, and `agent_helpers.py` has no primitives for that (its
select()/drag() only query canvas elements inside the iframe that carry
data-slidra-name). `browser-use`'s core layer, `browser_harness.helpers`
(`click_at_xy`/`js`/`fill_input`/`wait_for_element`/`http_get`), is injected
as globals through the same `exec(code, globals())` mechanism
(`browser_harness/run.py`: `from .helpers import *`) — it's the other half
of the same injection layer as `agent_helpers.py`'s primitives, not a
separate harness; this file uses them for the parent-document operations,
with `# noqa: F821` added at each call site the same way.

Acceptance: on base (main), the thumbnail context menu has no "Save as
template" entry — `_menuitem_rect` returning nothing is treated as an
immediate FAIL and the script stops there (so it can't be misread as
failing for some other reason). On the PR branch, once this entry is
added, saving should make the Templates list update immediately, and
applying it via New › Layouts should produce a new slide whose content
matches the source slide.
"""

import json
import os

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _server_url() -> str:
    return os.environ.get("SLIDRA_QA_URL", "http://127.0.0.1:5173").rstrip("/")


def _read_project() -> dict:
    return json.loads(http_get(f"{_server_url()}/api/raw/project.json"))  # noqa: F821


def _center(selector: str) -> dict:
    r = js(  # noqa: F821
        f"(()=>{{const e=document.querySelector({json.dumps(selector)});"
        "if(!e)return null;const r=e.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    if r is None:
        raise RuntimeError(f"Element not found: {selector}")
    return r


def _wait_gone(selector: str, timeout: float = 5.0) -> bool:
    """Polls until `selector` disappears from the DOM (or times out),
    returning whether it actually disappeared. `wait_for_element` only
    waits for something to *appear* — the opposite direction — so it can't
    be reused for waiting on a close."""
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not js(f"!!document.querySelector({json.dumps(selector)})"):  # noqa: F821
            return True
        time.sleep(0.1)
    return not js(f"!!document.querySelector({json.dumps(selector)})")  # noqa: F821


def _menuitem_rect(text: str):
    """Center coordinates of the first `[role=menuitem]` whose text starts
    with `text`, or None if not found (the caller decides whether that's a
    FAIL or a reason to abort)."""
    return js(  # noqa: F821
        "(()=>{const items=[...document.querySelectorAll('[role=\"menuitem\"]')];"
        f"const el=items.find(e=>e.textContent.trim().startsWith({json.dumps(text)}));"
        "if(!el)return null;const r=el.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )


def main() -> int:
    open_deck()  # noqa: F821
    template_name = "N-02 template"
    before = _read_project()
    source_path = before["slides"][1]  # slide 2 (0-based index 1)

    # Right-click slide 2's thumbnail to open its context menu.
    thumb = _center('.overview-item[data-index="1"]')
    click_at_xy(thumb["x"], thumb["y"], button="right")  # noqa: F821
    ok = wait_for_element('[data-testid="thumb-context-menu"]', timeout=5, visible=True)  # noqa: F821
    check("A-1 thumbnail context menu opens", ok, ok)
    if not ok:
        print("Summary: 1 failure (cannot continue)")
        return 1

    save_item = _menuitem_rect("Save as template")
    check("A-2 menu has a \"Save as template\" entry (base should not)", save_item is not None, save_item)
    if save_item is None:
        print(f"Summary: {len(FAILURES)} failed (known gap on base, cannot continue)")
        return 1

    click_at_xy(save_item["x"], save_item["y"])  # noqa: F821

    # Dialog: enter a name and submit.
    ok = wait_for_element('[aria-label="Save as template"]', timeout=5, visible=True)  # noqa: F821
    check("B-1 Save as template dialog opens", ok, ok)
    fill_input(".save-template-modal-input", template_name)  # noqa: F821
    save_button = _center(".save-template-modal-submit")
    click_at_xy(save_button["x"], save_button["y"])  # noqa: F821
    modal_closed = _wait_gone('[aria-label="Save as template"]', timeout=5)
    check("B-2 dialog closes after saving", modal_closed, modal_closed)

    # Templates list shows the new template immediately (no page refresh).
    templates_button = js(  # noqa: F821
        "(()=>{const b=[...document.querySelectorAll('.rail-action-button')]"
        ".find(e=>e.textContent.trim().startsWith('Templates'));"
        "if(!b)return null;const r=b.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    click_at_xy(templates_button["x"], templates_button["y"])  # noqa: F821
    ok = wait_for_element('[role="menu"][data-menu="templates"]', timeout=5, visible=True)  # noqa: F821
    check("C-1 Templates menu opens", ok, ok)
    in_templates_menu = _menuitem_rect(template_name)
    check("C-2 Templates list shows the new template immediately (no page refresh)", in_templates_menu is not None, in_templates_menu)
    press_key("Escape")  # noqa: F821

    # New › Layouts adds a slide from the new template.
    new_button = js(  # noqa: F821
        "(()=>{const b=[...document.querySelectorAll('.rail-action-button')]"
        ".find(e=>e.textContent.trim().startsWith('New'));"
        "if(!b)return null;const r=b.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    click_at_xy(new_button["x"], new_button["y"])  # noqa: F821
    ok = wait_for_element('[role="menu"][data-menu="new"]', timeout=5, visible=True)  # noqa: F821
    check("D-1 New menu opens", ok, ok)
    in_new_menu = _menuitem_rect(template_name)
    check("D-2 New › Layouts shows the new template immediately", in_new_menu is not None, in_new_menu)
    if in_new_menu is None:
        print(f"Summary: {len(FAILURES)} failed (cannot apply the template)")
        return 1
    click_at_xy(in_new_menu["x"], in_new_menu["y"])  # noqa: F821

    after = None
    import time

    deadline = time.time() + 10
    while time.time() < deadline:
        after = _read_project()
        if len(after["slides"]) == len(before["slides"]) + 1:
            break
        time.sleep(0.2)
    check(
        "E-1 slide_count() +1",
        after is not None and len(after["slides"]) == len(before["slides"]) + 1,
        None if after is None else len(after["slides"]),
    )

    new_slide_path = None
    if after is not None:
        candidates = [p for p in after["slides"] if p not in before["slides"]]
        new_slide_path = candidates[0] if candidates else None
    check("E-2 can locate the newly inserted slide's path", new_slide_path is not None, new_slide_path)

    if new_slide_path is not None:
        source_content = http_get(f"{_server_url()}/api/raw/{source_path}")  # noqa: F821
        new_content = http_get(f"{_server_url()}/api/raw/{new_slide_path}")  # noqa: F821
        import re

        def normalize_ids(svg: str) -> str:
            seen: dict[str, str] = {}
            counter = 0

            def repl(m: "re.Match[str]") -> str:
                nonlocal counter
                token = m.group(0)
                if token not in seen:
                    seen[token] = f"el-NORMALIZED-{counter}"
                    counter += 1
                return seen[token]

            return re.sub(r"el-[A-Za-z0-9_-]+", repl, svg)

        check(
            "E-3 new slide's content matches slide 2 (ignoring regenerated element ids)",
            normalize_ids(new_content) == normalize_ids(source_content),
            {"new_len": len(new_content), "source_len": len(source_content)},
        )

    check("F-1 no console errors", console_errors() == [], console_errors())  # noqa: F821
    shot("N-02")  # noqa: F821

    print(f"Summary: {len(FAILURES)} failed" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


raise SystemExit(main())
