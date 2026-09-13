"""N-01: drag-to-move regression test.

Depends on the sandbox QA layer (`scripts/quick_start.sh --qa` brings up the
environment; `qa/agent_helpers.py` provides the following fixed primitives):

    open_deck() / select(name_or_id) / selection() / drag(from_xy, to_xy) /
    slide_svg(n) / save_state() / console_errors()

These primitives are injected as globals by `browser-use` via
`exec(code, globals())` (see qa/cases/smoke.py) — they aren't an importable
module, so this file calls them directly and adds `# noqa: F821` at each
call site. Beyond that fixed list, this file also uses two of browser-use's
"core" primitives, `cdp()` and `js()` (not additions to agent_helpers.py —
any case script can already use them) — the reasoning is in the two
sections below, and neither is avoidable.

## Root cause

The original suspicion was that the bug lived in `beginMoveGesture` (the
construction of `selectionIds`/`originals`). That didn't hold up under
testing: `gesture-start`/`gesture-move`/`preview` all arrive fine, and
`beginMoveGesture` never returns early. The real root cause is that the
slide runs in an out-of-process sandboxed iframe — once a drag carries the
cursor past that iframe's actual rendered bounds, the ordinary
cross-document hit-test stops routing further pointermove/pointerup events
into the iframe (calling `Element.setPointerCapture()` inside the iframe has
no effect on an out-of-process sandboxed frame — verified by testing, not a
guess), so the iframe never gets its own `gesture-end`: the preview freezes,
no `element move` is emitted, there's no undo step, and nothing shows up in
the console either — exactly N-01's symptom. The fix hands off
pointermove/pointerup, once the pointer has left the iframe, to the host
(canvas.ts's own window listener) to finish the gesture.

## Why the "20px past the boundary" case is kept alongside the literal 200px case

An earlier draft replaced the acceptance criterion's "drag 200px" entirely
with "drag 20px past the iframe's actual boundary", but that isn't
equivalent: on the demo's first slide, at 1440x900 with default zoom, the
title's center has about 416px of room before it reaches the iframe's right
edge, so a plain 200px horizontal drag never crosses the iframe boundary at
all — that literal number doesn't exercise the out-of-process defect itself.
The resolution: the acceptance criterion is fine as written, and both cases
should stay — `_move_and_undo()` first runs the literal "200px" case (this
measures that the drag/select/save/undo path itself isn't broken; the PR
branch and base will typically both PASS here, since 200px doesn't cross the
iframe boundary at this layout), then the "20px past the boundary" case
(kept as the actual regression case for the out-of-process defect; PR branch
PASSes, base FAILs). Both cases share the same drag/verify/undo logic
(`_move_and_undo()`) — they differ only in how the endpoint is computed.

## Environment trap: caching when comparing the PR branch against base within the same QA session

The established flow (qa/README.md §3) is: within the same pod, run the PR
branch once, tear it down with `--qa-stop`, switch to base, and bring it up
again with `--qa`. Chromium's `--user-data-dir` is the same `profile/`
across both runs and isn't cleared between `--qa` invocations; `index.html`
itself carries no cache-busting headers, and only asset filenames are
hashed — so the tab started by the second `--qa` can easily keep serving
the previous commit's bundle, making both runs execute the same code and
rendering PASS/FAIL meaningless (verified in practice: the hash in
`document.scripts`'s `src` didn't match the hash the server was actually
serving at the time). The `cdp("Network.setCacheDisabled")` +
`cdp("Page.reload", ignoreCache=True)` at the start of `main()` guards
against exactly this — it isn't unique to this script; it's a trap any case
script comparing two commits within the same QA session will hit.

## Why the snap-guide assertion bypasses drag()

`agent_helpers.py`'s `drag()` is a one-shot, blocking-to-completion
primitive (press -> N moves -> release, all in one call) with no primitive
for "pause mid-drag to inspect the DOM", but the acceptance criterion
requires observing the snap-guide DOM appearing while the gesture is still
in progress — something only visible mid-gesture. So this uses `cdp()`/`js()`
to dispatch raw mouse events by hand and poll for the `.guide` element
between each move step — the steps match `drag()`'s internals exactly, just
split apart so it can be inspected mid-gesture; this isn't a different
harness, and it doesn't add a named primitive to agent_helpers.py.

## Thumbnail sync

Feedback that "N-01 doesn't verify thumbnail sync" is instead covered at
the existing e2e layer: `e2e/direct-manipulation.test.ts` gained a case —
"after releasing a single-element drag: the overview thumbnail's
(`iframe.overview-frame`) transform updates in step; undo restores the
thumbnail too" — the QA sandbox layer has no primitive that can read the
`.overview-thumb` iframe's `srcdoc` content directly, and the e2e layer
already has an existing test file with the same input that can verify
thumbnail updates, which is cheaper than inventing a new primitive in this
script. This file doesn't duplicate that assertion.
"""

import os
import re
import time
import urllib.error
import urllib.request

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def _title_transform(svg_text: str) -> str | None:
    m = re.search(r'<g\s+([^>]*\bid="el-title"[^>]*)>', svg_text)
    if not m:
        return None
    tm = re.search(r'transform="([^"]*)"', m.group(1))
    return tm.group(1) if tm else None


def _server_url() -> str:
    # `qa/agent_helpers.py`'s `_server_url()` is a private name and gets
    # filtered out by the exec() injection; `SLIDRA_QA_URL` is the public
    # source of the same information (written into qa.env by
    # quick_start.sh), so using it avoids re-inventing a primitive of the
    # same name.
    return os.environ.get("SLIDRA_QA_URL", "http://127.0.0.1:5173").rstrip("/")


def _move_and_undo(label: str, next_n: int, to_point) -> int:
    """Selects "標題" (Title), drags from its center to the endpoint computed
    by `to_point(box, from_x, from_y)`, verifies the transform changed /
    selection is preserved / it was saved, then POSTs /api/undo to restore it
    and verifies the transform reverted to its pre-drag value. `next_n` is
    the starting number for this group of assertions; returns the next
    available number (so callers chaining multiple scenarios share one
    numbering sequence).
    """
    before_svg = slide_svg(1)  # noqa: F821
    before_transform = _title_transform(before_svg)

    # When this call comes right after another `_move_and_undo()` call in
    # the same session, the SSE reload triggered by the previous call's
    # /api/undo may not have reached this tab yet: select() (which only
    # relies on _wait_frame_ready()) might measure the title's on-screen
    # position from the "previous generation" iframe, and by the time the
    # mouse events actually dispatch the new iframe is already in place and
    # the title is no longer at that position — the press lands on empty
    # space, so the selection comes back empty instead of "標題", and no
    # transform change is measured at all. This is distinct from the actual
    # bug's symptom (iframe never gets pointerup, selection stays "標題" but
    # no element move happens) — a real repro always leaves the selection
    # on "標題". Use this signal to tell the two apart: only treat "selection
    # came back empty" as "measured a stale generation, retry"; if the
    # selection is still "標題" but there's no new transform, report it as
    # the real FAIL it is, without retrying.
    #
    # Testing showed that not waiting at all on the first attempt
    # (settle_wait=0) doesn't just cause a stale selection —
    # `Input.dispatchMouseEvent` itself can hang for a full 20-second
    # timeout on this sandbox pod (the daemon dispatching events at a CDP
    # target that's mid-swap from an SSE reload); `_dispatch_mouse()`
    # deliberately doesn't retry after a timeout (per agent_helpers.py: a
    # timeout doesn't mean the event never landed, and retrying risks
    # firing the gesture twice), so this can't be patched up after the
    # fact by retrying post-dispatch — the only fix is waiting long enough
    # before dispatching, including on the very first attempt.
    after_transform = None
    after_sel = {"chip": ""}
    for attempt, settle_wait in enumerate((1.5, 3.0, 5.0), start=1):
        time.sleep(settle_wait)

        sel = select("標題")  # noqa: F821
        box = sel["box"]
        if box is None:
            check(f"{next_n} [{label}] select('標題')['box'] is not None", False, None)
            return next_n + 1

        from_x, from_y = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
        to_x, to_y = to_point(box, from_x, from_y)

        drag((from_x, from_y), (to_x, to_y))  # noqa: F821

        after_svg = slide_svg(1)  # noqa: F821
        after_transform = _title_transform(after_svg)
        after_sel = selection()  # noqa: F821
        if after_sel["chip"] != "":
            break
        print(f"  ([{label}] attempt {attempt}: selection came back empty after the drag, likely measured a stale frame from a prior action's SSE reload — retrying)")

    n = next_n
    check(
        f"{n} [{label}] el-title carries a new transform after the drag (and it differs from before)",
        after_transform is not None and after_transform != before_transform,
        after_transform,
    )
    n += 1

    check(
        f"{n} [{label}] selection is still 「標題」 after the drag (the context bar/status bar didn't lose the selection)",
        after_sel["chip"] == "Selected: 標題",
        after_sel["chip"],
    )
    n += 1

    save = save_state()  # noqa: F821
    check(f"{n} [{label}] save_state() shows the file was written", save.get("dirty") is True, save)
    n += 1

    # agent_helpers.py has no undo or generic POST primitive: this hits
    # /api/undo directly, the same endpoint the UI's Undo button / Cmd-Z use
    # (apps/web/src/App.tsx's runUndoRedo) — using only the standard
    # library, so it doesn't count as a new primitive. On base, where item 1
    # above is already expected to FAIL (the drag never got saved), there's
    # no history to undo here, so `/api/undo` returns 400 (verified) instead
    # of 200 — caught with try/except so the script can keep printing the
    # full FAIL list instead of raising and aborting here.
    try:
        undo_req = urllib.request.Request(_server_url() + "/api/undo", method="POST")
        with urllib.request.urlopen(undo_req) as resp:
            undo_status = resp.status
    except urllib.error.HTTPError as exc:
        undo_status = exc.code
    check(f"{n} [{label}] POST /api/undo returns 200 (any other value means there was no history to undo)", undo_status == 200, undo_status)
    n += 1

    after_undo_svg = slide_svg(1)  # noqa: F821
    after_undo_transform = _title_transform(after_undo_svg)
    check(
        f"{n} [{label}] el-title's transform reverts to its pre-drag value after one undo",
        after_undo_transform == before_transform,
        after_undo_transform,
    )
    n += 1

    return n


def main() -> int:
    # See the "environment trap" section at the top of this file: this
    # guards against measuring a cached bundle left over from a previous
    # commit.
    cdp("Network.setCacheDisabled", cacheDisabled=True)  # noqa: F821
    cdp("Page.reload", ignoreCache=True)  # noqa: F821
    time.sleep(1.5)

    deck = open_deck()  # noqa: F821
    if deck["slides"] < 1:
        print(f"FAIL open_deck()['slides'] expected>=1 actual={deck['slides']!r}")
        return 1

    n = 1

    # --- Scenario A: the acceptance criterion's literal "drag 200px" ---
    n = _move_and_undo("200px", n, lambda box, fx, fy: (fx + 200, fy))

    # --- Scenario B: drag to 20px past the iframe's actual boundary (the
    # extra regression case kept alongside the literal one — see "Why the
    # 20px past the boundary case is kept" at the top of this file) ---
    def _to_iframe_edge(box, fx, fy):
        iframe_rect = js(  # noqa: F821
            "(()=>{const f=document.querySelector('iframe.slide-frame');"
            "const r=f.getBoundingClientRect();"
            "return {x:r.x,y:r.y,width:r.width,height:r.height};})()"
        )
        return (iframe_rect["x"] + iframe_rect["width"] + 20, fy)

    n = _move_and_undo("20px past boundary", n, _to_iframe_edge)

    # --- Snap guide: the DOM really does appear while dragging close to
    # another element's edge ---
    # See "Why the snap-guide assertion bypasses drag()" at the top of this
    # file. Re-select "標題" (Title) and drag it down toward "副標"
    # (Subtitle): both are center-aligned text, so their horizontal centers
    # are already aligned, and a vertical snap guide (`.guide.guide-v`)
    # should be drawn once they line up.
    #
    # The snap candidate's (e.g. "副標") bounds only make it into the host's
    # elementBoundsById after selection-runtime.js's reportElementBounds()
    # sends "element-bounds" — this has to be re-reported every time the
    # iframe is rebuilt (here, the SSE reload triggered by each of the two
    # scenarios' undo above), and `select()`'s internal
    # `_wait_frame_ready()` only confirms the iframe's own DOM is ready — it
    # doesn't wait for this extra postMessage round trip, and
    # document.fonts.ready needs to be waited on again too. This timing is
    # quite noisy on this sandbox pod: a fixed sleep anywhere from 2.5 to 5
    # seconds has produced a false negative at least once (the guide didn't
    # appear — not because the assertion is wrong, but because the drag
    # started before the measurement round trip had landed). Rather than
    # guessing at a longer fixed delay, this retries up to 3 times,
    # re-selecting for fresh coordinates each time and increasing the wait —
    # one true positive counts as a PASS; only failing every attempt is a
    # real FAIL.
    guide_seen = False
    for attempt, wait_s in enumerate((2.0, 4.0, 6.0), start=1):
        sel2 = select("標題")  # noqa: F821
        box2 = sel2["box"]
        fx2, fy2 = box2["x"] + box2["w"] / 2, box2["y"] + box2["h"] / 2
        tx2, ty2 = fx2, fy2 + 90
        time.sleep(wait_s)

        cdp(  # noqa: F821
            "Input.dispatchMouseEvent", type="mousePressed", x=fx2, y=fy2, button="left", buttons=1, clickCount=1
        )
        steps = 15
        for i in range(1, steps + 1):
            x = fx2 + (tx2 - fx2) * i / steps
            y = fy2 + (ty2 - fy2) * i / steps
            cdp("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y, button="left", buttons=1)  # noqa: F821
            time.sleep(0.03)
            if js("document.querySelectorAll('.guide').length") > 0:  # noqa: F821
                guide_seen = True
        cdp(  # noqa: F821
            "Input.dispatchMouseEvent", type="mouseReleased", x=tx2, y=ty2, button="left", buttons=0, clickCount=1
        )
        time.sleep(0.3)
        print(f"  (snap guide attempt {attempt}, dragged after waiting {wait_s}s: {'seen' if guide_seen else 'not seen'})")
        if guide_seen:
            break
    check(f"{n} the snap-guide DOM (.guide) appeared at some point while dragging near another element's edge", guide_seen, guide_seen)
    n += 1

    # console_errors() is called only after all gesture assertions: it
    # attaches an extra CDP session to the slide iframe's target and calls
    # Runtime.enable (see agent_helpers.py's implementation), and in testing
    # this attach makes measurement/snap timing unreliable for anything that
    # happens "afterward" on the same iframe generation (the snap-guide
    # check above fails to measure the guide if done after
    # console_errors() — reordering it makes it reliable again). qa/README.md
    # already notes it's mutually exclusive with wait_for_network_idle();
    # this is the same underlying cause (both attach an extra debugger
    # session) showing up in a new interaction that hadn't been documented
    # before.
    errs = console_errors()  # noqa: F821
    check(f"{n} no console errors throughout", errs == [], errs)
    n += 1

    print(f"Summary: {len(FAILURES)} failed" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use executes stdin scripts with exec(code, globals()), where
# globals()['__name__'] is "browser_harness.run" — never "__main__"
# (qa/README.md §2). Call unconditionally instead, and let the exit code
# decide the caller's process exit status.
raise SystemExit(main())
