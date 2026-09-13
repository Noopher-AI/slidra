"""F-01: the slide gets clipped by the browser's scrollbar.

Depends on the sandbox QA layer (`scripts/quick_start.sh --qa` brings up the
environment; `qa/agent_helpers.py` provides the following fixed
primitives, and `browser_harness.helpers` provides `cdp()`/`js()`) — this
script only uses this list; it doesn't add new primitives or switch to a
different harness (same convention as qa/cases/F-15.py):

    open_deck() / cdp(method, **params) / js(expression, target_id=None)

Acceptance: neither `div.stage` nor the play-mode container (the same
`.stage` — play.css only changes color, not layout) should have a
`scrollHeight`/`scrollWidth` exceeding its own `clientHeight`/`clientWidth`;
the same measurement on the `<html>` inside the srcdoc must not overflow
either. Measured once in edit mode and once in play mode — the fix
(`.slide-frame{display:block}` plus `svg{display:block}` inside the
srcdoc) needs both layers to hold, and missing either one shows up in one
of the two measurements.
"""

import sys

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _stage_iframe_target_id(attempts: int = 20, interval: float = 0.25) -> str:
    """The main stage's `iframe.slide-frame` CDP target id.

    Matched via DOM.describeNode's frameId (verified to equal the OOPIF's
    Target.getTargets() targetId), not iframe_target("srcdoc") — that core
    primitive matches every srcdoc iframe in the browser, including the
    overview thumbnails (each one is its own srcdoc document,
    apps/web/src/overview.ts), which would make target selection
    ambiguous. `iframe.slide-frame` is a class unique to the main stage
    (thumbnails use `.overview-frame` — apps/web/src/overview.ts:197).
    """
    import time

    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            doc = cdp("DOM.getDocument", depth=0)  # noqa: F821
            root_id = doc["root"]["nodeId"]
            found = cdp("DOM.querySelector", nodeId=root_id, selector="iframe.slide-frame")  # noqa: F821
            node_id = found.get("nodeId")
            if not node_id:
                time.sleep(interval)
                continue
            described = cdp("DOM.describeNode", nodeId=node_id, depth=0)  # noqa: F821
            frame_id = described.get("node", {}).get("frameId")
            if not frame_id:
                time.sleep(interval)
                continue
            targets = cdp("Target.getTargets")["targetInfos"]  # noqa: F821
            for t in targets:
                if t.get("type") == "iframe" and t.get("targetId") == frame_id:
                    return frame_id
            time.sleep(interval)
        except Exception as exc:  # noqa: BLE001 - retry on transient CDP errors (DOM rebuilding)
            last_exc = exc
            time.sleep(interval)
    raise RuntimeError(f"Could not find the CDP target for iframe.slide-frame (gave up after {attempts} retries)") from last_exc


def _measure_scroll(expr_target: str) -> dict:
    return js(  # noqa: F821
        f"(()=>{{const el={expr_target};"
        "return {scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,"
        "clientWidth:el.clientWidth,clientHeight:el.clientHeight};})()"
    )


def _measure_srcdoc() -> dict:
    frame_id = _stage_iframe_target_id()
    return js(  # noqa: F821
        "(()=>{const el=document.documentElement;"
        "return {scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight,"
        "clientWidth:el.clientWidth,clientHeight:el.clientHeight};})()",
        target_id=frame_id,
    )


def _no_overflow(label: str, m: dict) -> None:
    check(f"{label}: scrollWidth <= clientWidth", m["scrollWidth"] <= m["clientWidth"], m)
    check(f"{label}: scrollHeight <= clientHeight", m["scrollHeight"] <= m["clientHeight"], m)


def main() -> int:
    open_deck()  # noqa: F821

    edit_stage = _measure_scroll("document.querySelector('.stage')")
    _no_overflow("edit mode .stage", edit_stage)
    edit_srcdoc = _measure_srcdoc()
    _no_overflow("edit mode srcdoc documentElement", edit_srcdoc)

    # Selector verified to work (see the play button in TitleBar.tsx:177).
    js("document.querySelector('.play-button').click()")  # noqa: F821
    import time

    # Wait for play mode to actually switch pages: `.titlebar` leaves the
    # DOM (App.tsx's shellVisible gate), and the play iframe (an entirely
    # rebuilt new document) resolves to a new CDP target whose content has
    # finished loading. Deliberately **not** waiting on
    # `.play-bar[data-player-focus="true"]` — that flag tracks whether
    # keyboard focus is on the player, which has nothing to do with the
    # layout dimensions this script checks; testing on this sandbox pod's
    # browser-use Chromium showed that the cross-document focus path
    # (`frame.contentWindow?.focus()` / `window.focus()`) frequently
    # doesn't land (a headless CDP-attached tab has no real window focus)
    # even once the slide is fully rendered and its measurements are
    # stable — using it as the "play mode is ready" signal causes false
    # timeouts under this harness.
    deadline = time.time() + 15.0
    ready = False
    while time.time() < deadline:
        try:
            if js("document.querySelectorAll('.titlebar').length") != 0:  # noqa: F821
                time.sleep(0.2)
                continue
            frame_id = _stage_iframe_target_id(attempts=1)
            state = js("document.readyState", target_id=frame_id)  # noqa: F821
            has_svg = js("!!document.querySelector('svg')", target_id=frame_id)  # noqa: F821
            if state == "complete" and has_svg:
                ready = True
                break
        except Exception:  # noqa: BLE001 - the iframe may still be rebuilding, keep polling
            pass
        time.sleep(0.2)
    if not ready:
        print("FAIL entering play mode timed out: the play iframe hadn't finished rendering within 15 seconds")
        return 1

    play_stage = _measure_scroll("document.querySelector('.stage')")
    _no_overflow("play mode .stage", play_stage)
    play_srcdoc = _measure_srcdoc()
    _no_overflow("play mode srcdoc documentElement", play_srcdoc)

    print(f"Summary: {len(FAILURES)} failed" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


raise SystemExit(main())
