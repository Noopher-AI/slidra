"""CoMotion primitives for browser-use (BH_AGENT_WORKSPACE/agent_helpers.py).

Loaded once per `browser-use` invocation by browser_harness.helpers
(_load_agent_helpers): every top-level name not starting with "_" becomes a
global available to case scripts, the same way core helpers like js()/cdp()
are. Module-level code below must never fail — an exception here breaks
every browser-use call in this workspace, including `--doctor`.

Verified against browser-use 0.1.13. See qa/README.md for the primitive
list, known limitations, and how to run qa/cases/smoke.py.
"""

import json
import math
import os
import re
import time
from pathlib import Path

from browser_harness.helpers import (
    capture_screenshot as _capture_screenshot,
    cdp as _cdp,
    current_tab as _current_tab,
    drain_events as _drain_events,
    http_get as _bh_http_get,
    new_tab as _new_tab,
    wait_for_load as _wait_for_load,
)

_DEFAULT_URL = "http://127.0.0.1:5173"
_FRAME_READY_TIMEOUT = 15.0
# open_deck()'s first navigation pays costs no later goto_slide() rebuild
# does: cold V8 JIT, a cold disk cache for Chromium's own binary and the
# app's JS bundle, and (on a sandbox pod) contention with whatever the rest
# of `quick_start.sh --qa` just finished building. Measured on this pod: the
# same commit failed _require_runtime_ready()'s plain 15s bound on a build
# fresh off `sandbox-setup`, then passed immediately on a rerun with
# everything warm — same code, different outcome, so the 15s bound (not the
# app) was the problem. goto_slide()'s rebuilds happen against an already-
# warm browser and stay on _FRAME_READY_TIMEOUT so per-gesture waits in a
# case script don't get slower for a one-time cost.
_INITIAL_LOAD_TIMEOUT = 45.0
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SLIDE_NAV_RE = re.compile(r"Slide (\d+) of (\d+)")

# Read-only CDP/JS calls (below, via _cdp_ro/_js_ro) get this per-attempt
# response timeout and up to _IPC_RETRY_ATTEMPTS tries, _IPC_RETRY_INTERVAL
# apart, applied uniformly — including calls made from inside the existing
# polling loops (_wait_frame_ready, _wait_chip_update, status_bar() as used
# by _wait_status_bar_settled). Those loops already either catch a failed
# attempt and keep polling (_wait_frame_ready's readiness check) or simply
# never caught one before this change either (a bare 5s timeout already
# propagated unhandled out of _wait_chip_update / _wait_status_bar_settled
# pre-round-5) — so retrying with a longer, configurable timeout only makes
# an already-possible slow/failed iteration deliberate and legible instead
# of an accidental bare TimeoutError. _FRAME_READY_TIMEOUT/
# _DRAG_SETTLE_TIMEOUT themselves are untouched; a degraded environment may
# now spend one longer attempt before a loop's own deadline check ends it,
# rather than looping fast against a too-short per-call timeout.
_DEFAULT_IPC_TIMEOUT = 20.0
_IPC_RETRY_ATTEMPTS = 3
_IPC_RETRY_INTERVAL = 0.5
_CHIP_UPDATE_TIMEOUT = 2.0
# How long to wait for a slide change to actually start rebuilding the iframe
# before concluding that it never will. Measured, not guessed: over 12 clicks
# on a slide thumbnail, every rebuild that happened began 0.029s-0.076s after
# the click, and the rest never began at all (clicking the thumbnail of the
# slide already on screen is a no-op). So this only has to clear ~0.08s with
# margin, and the no-op case — which pays the full wait — should not be made
# to pay more than that.
_REBUILD_START_GRACE = 0.3


def _ipc_timeout():
    """CO_MOTION_QA_IPC_TIMEOUT, parsed lazily (never at import time — this
    module's top-level code must never raise, see module docstring)."""
    raw = os.environ.get("CO_MOTION_QA_IPC_TIMEOUT")
    if raw is None or raw == "":
        return _DEFAULT_IPC_TIMEOUT
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"CO_MOTION_QA_IPC_TIMEOUT 必須是數字，收到 {raw!r}") from None
    if value <= 0:
        raise ValueError(f"CO_MOTION_QA_IPC_TIMEOUT 必須是正數，收到 {raw!r}")
    return value


def _cdp_ro(method, **params):
    """Read-only CDP call with retry-on-timeout. Never use this for
    Input.dispatchMouseEvent — a timeout there doesn't mean the event wasn't
    delivered, so retrying could double-fire a gesture (see _dispatch_mouse)."""
    timeout = _ipc_timeout()
    last_exc = None
    for attempt in range(1, _IPC_RETRY_ATTEMPTS + 1):
        try:
            return _cdp(method, _response_timeout=timeout, **params)
        except TimeoutError as exc:
            last_exc = exc
            if attempt < _IPC_RETRY_ATTEMPTS:
                time.sleep(_IPC_RETRY_INTERVAL)
    raise RuntimeError(
        f"{method} 逾時：已嘗試 {_IPC_RETRY_ATTEMPTS} 次，每次逾時 {timeout:g}s"
    ) from last_exc


def _js_ro(expression, target_id=None):
    """Runtime.evaluate with _cdp_ro's timeout+retry. Reimplements
    browser_harness.helpers.js()'s eval semantics because the public js()
    hardcodes a 5s response timeout with no override (verified: helpers.py
    js()/_send at :561/:53 take no caller-supplied timeout)."""
    session_id = None
    if target_id:
        session_id = _cdp_ro("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]
    try:
        r = _cdp_ro(
            "Runtime.evaluate",
            session_id=session_id,
            expression=expression,
            returnByValue=True,
            awaitPromise=True,
        )
        result = r.get("result", {})
        details = r.get("exceptionDetails")
        if details or result.get("subtype") == "error":
            desc = result.get("description") or (details or {}).get("text") or "JavaScript evaluation failed"
            raise RuntimeError(f"JavaScript evaluation failed: {desc}; expression: {expression[:160]!r}")
        if "value" in result:
            return result["value"]
        if "unserializableValue" in result:
            return result["unserializableValue"]
        return None
    finally:
        if session_id:
            try:
                _cdp("Target.detachFromTarget", sessionId=session_id)
            except Exception:
                pass


def _dispatch_mouse(**params):
    """Input.dispatchMouseEvent, no retry (round-5 plan): a timeout here
    doesn't mean the event wasn't delivered, so retrying could double-fire
    the gesture. On timeout, best-effort release the mouse button so it
    doesn't stay stuck down for the next caller, then raise."""
    # A press that starts a gesture must never be dispatched into the window
    # where the slide iframe has been rebuilt but its listeners are not
    # attached yet — the event is dropped silently there. See
    # _require_runtime_ready.
    if params.get("type") == "mousePressed":
        _require_runtime_ready()
    timeout = _ipc_timeout()
    try:
        return _cdp("Input.dispatchMouseEvent", _response_timeout=timeout, **params)
    except TimeoutError as exc:
        if params.get("type") != "mouseReleased":
            try:
                _cdp(
                    "Input.dispatchMouseEvent",
                    _response_timeout=timeout,
                    type="mouseReleased",
                    x=params.get("x"),
                    y=params.get("y"),
                    button=params.get("button", "left"),
                    buttons=0,
                    clickCount=params.get("clickCount", 1),
                )
            except Exception:
                pass
        raise RuntimeError(
            f"Input.dispatchMouseEvent({params.get('type')}) 逾時（{timeout:g}s）；"
            "已嘗試補送 mouseReleased 避免滑鼠鍵卡在按下狀態"
        ) from exc


def _click(x, y, clicks=1):
    """pressed -> released at (x, y), via _dispatch_mouse — reimplements
    browser_harness.helpers.click_at_xy()'s gesture because that core
    primitive (imported nowhere in this module anymore) hardcodes a 5s
    response timeout with no override, same gap as js()."""
    _dispatch_mouse(type="mousePressed", x=x, y=y, button="left", clickCount=clicks)
    _dispatch_mouse(type="mouseReleased", x=x, y=y, button="left", clickCount=clicks)


def _qa_dir():
    return Path(__file__).resolve().parent


def _server_url():
    return os.environ.get("CO_MOTION_QA_URL", _DEFAULT_URL).rstrip("/")


def _http_get(url):
    try:
        return _bh_http_get(url)
    except Exception as exc:
        hint = ""
        if not os.environ.get("CO_MOTION_QA_URL"):
            hint = "（CO_MOTION_QA_URL 未設，已使用預設值 http://127.0.0.1:5173；請先 source .quickstart/qa/qa.env）"
        raise RuntimeError(f"HTTP GET {url} 失敗：{exc}{hint}") from exc


def _activate_current_tab():
    """Bring the QA tab to the front via CDP Target.activateTarget.

    Verified empirically (round 5): a freshly opened/reused headless-Chromium
    tab is not necessarily the browser's "active" target (another target,
    e.g. the initial about:blank page, can hold that state). Input events
    dispatched to a non-active target still land on the right DOM element
    (confirmed via document.elementFromPoint at the click coordinates) but
    produce no app-level effect at all -- deterministically, every time, not
    intermittently -- because the click never becomes a registered
    interaction. This reproduces r3/r4's "select() chip stays empty" /
    "'NoneType' object is not subscriptable" failures independently of any
    IPC timeout."""
    try:
        tid = _current_tab()["targetId"]
    except Exception:
        return
    _cdp_ro("Target.activateTarget", targetId=tid)


# CDP node ids are handles into a per-connection cache that the browser
# invalidates whenever the DOM they point at changes. Resolving the slide
# iframe takes three separate round trips (getDocument -> querySelector ->
# describeNode) and the app rebuilds that iframe on every slide change, so the
# sequence races: a rebuild landing between calls makes the browser answer
# "Could not find node with given id" (-32000), or hand back a node id that
# describes the iframe that is already gone.
#
# NOOP-349: this is the second way this harness measured the wrong thing. A
# stale frame id resolves to the PREVIOUS document, so _find_target_box()
# computes its coordinates there and the click lands wherever that element
# used to be — the chip never appears and select() reports "點擊可能沒有效果"
# after its timeout. Widening that timeout does nothing, because nothing is
# ever going to arrive. Re-fetching the document (which is what refreshes the
# node cache) and trying again is the actual fix.
_STALE_NODE_MESSAGE = "Could not find node"


def _iframe_frame_id(attempts=3):
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            doc = _cdp_ro("DOM.getDocument", depth=0)
            root_id = doc.get("root", {}).get("nodeId")
            if not root_id:
                return None
            node_id = _cdp_ro("DOM.querySelector", nodeId=root_id, selector="iframe.slide-frame").get("nodeId")
            if not node_id:
                return None
            described = _cdp_ro("DOM.describeNode", nodeId=node_id, depth=0)
            return described.get("node", {}).get("frameId")
        except RuntimeError as exc:
            if _STALE_NODE_MESSAGE not in str(exc):
                raise
            # The DOM moved under us. The next getDocument() above re-seeds the
            # node cache, so simply going round again resolves against the
            # document that actually exists now.
            last_exc = exc
            if attempt < attempts:
                time.sleep(0.1)
    raise RuntimeError(
        f"解析投影片 iframe 的 frameId 連續 {attempts} 次都撞到失效的 CDP node id"
        "（DOM 一直在變動，可能是投影片正在重建）"
    ) from last_exc


def _iframe_target_id():
    """The slide iframe's CDP target id, or None if it doesn't exist yet.

    DOM.describeNode's frameId equals the OOPIF's Target.getTargets() targetId
    (verified empirically) — this is deliberately not iframe_target("srcdoc"),
    which matches every srcdoc iframe in the browser (overview thumbnails,
    other tabs), not just this deck's.
    """
    frame_id = _iframe_frame_id()
    if not frame_id:
        return None
    for t in _cdp_ro("Target.getTargets").get("targetInfos", []):
        if t.get("type") == "iframe" and t.get("targetId") == frame_id:
            return frame_id
    return None


# The slide runs in a sandboxed srcdoc iframe that the app REBUILDS on every
# slide change. selection-runtime.js appends its selection host and parses the
# slide markup BEFORE it calls addEventListener, and only then posts
# "runtime-ready" — its own comment notes that a postMessage sent before that
# point "would be silently dropped". The same hole exists in the other
# direction, and it is the one that bites here: a CDP Input event dispatched
# into that gap lands on a document with no pointer listeners and is discarded
# without a trace. No error, no console entry, no gesture-start/move/end — the
# gesture simply never happened, and the assertion that follows measures the
# state from before it.
#
# NOOP-349: this is what made F-15's B-2 fail for five review rounds. It was
# read as "the marquee hit the wrong number of elements" and chased through
# browser-use/CDP timeouts, /dev/shm sizing and Target.activateTarget, none of
# which were involved. Instrumenting the parent's message channel showed the
# failing runs carried no gesture events at all, only the previous iframe's
# blur. Waiting for the real signal took B-2 from 2/6 to 6/6, and F-15 as a
# whole from "never clean" to 3/3.
#
# The probe below tracks that signal from the parent document:
#   pending  True between "the iframe's srcdoc was replaced" and "the new
#            document said it is ready" — i.e. exactly the window in which
#            dispatching input is silently lost. This, not "a runtime-ready
#            arrived", is the condition to wait on: clicking the thumbnail of
#            the slide already on screen does not always rebuild the iframe,
#            so "wait for the next runtime-ready" hangs on the no-op case.
#   seq      how many "runtime-ready" messages have arrived since install.
#            Diagnostic only — nothing waits on it.
# `pending` starts False so an already-settled iframe is not made to wait for
# a signal that has already come and gone; `mark_pending` lets a caller that
# just triggered a rebuild itself (open_deck's new tab) declare the window
# open before the mutation observer could possibly see it.
_READY_PROBE_JS = """
(function (markPending) {
  // Bumped whenever the shape of the state object changes. A probe left over
  // from an older agent_helpers.py survives in the page across browser-use
  // invocations (the tab is deliberately reused), and without this check the
  // stale object would be kept and every field added since would read back as
  // undefined.
  var VERSION = 2;
  var s = window.__cmQaReady;
  if (!s || s.v !== VERSION) {
    s = { v: VERSION, seq: 0, pending: false };
    window.__cmQaReady = s;
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (d && typeof d === "object" && d.event === "runtime-ready") {
        s.seq += 1;
        s.pending = false;
      }
    }, true);
    var watch = function (f) {
      if (!f || f.__cmQaWatched) return;
      f.__cmQaWatched = true;
      new MutationObserver(function () { s.pending = true; })
        .observe(f, { attributes: true, attributeFilter: ["srcdoc"] });
    };
    watch(document.querySelector("iframe.slide-frame"));
    // The iframe element itself is replaced on some transitions, not just its
    // srcdoc — re-attach the observer whenever a new one appears.
    new MutationObserver(function () { watch(document.querySelector("iframe.slide-frame")); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
  if (markPending) s.pending = true;
  return { seq: s.seq, pending: !!s.pending };
})(MARK_PENDING)
"""


def _ready_probe(mark_pending=False):
    """(seq, pending) from the parent-document runtime-ready probe, installing
    it on first use and after any parent reload (which wipes it)."""
    r = _js_ro(_READY_PROBE_JS.replace("MARK_PENDING", "true" if mark_pending else "false"))
    if not isinstance(r, dict) or "seq" not in r or "pending" not in r:
        raise RuntimeError(f"runtime-ready probe 回傳了非預期的形狀：{r!r}")
    return int(r["seq"]), bool(r["pending"])


def _wait_rebuild_started(grace=_REBUILD_START_GRACE):
    """Give a just-triggered slide change `grace` seconds to actually begin.

    Returns as soon as the rebuild is observed, so the common case costs one
    poll interval rather than the whole grace period. Returning without having
    seen one is a legitimate outcome, not an error: clicking the thumbnail of
    the current slide is a no-op, and so is any caller that did not navigate.
    """
    deadline = time.time() + grace
    while time.time() < deadline:
        _, pending = _ready_probe()
        if pending:
            return True
        time.sleep(0.05)
    return False


def _require_runtime_ready(timeout=_FRAME_READY_TIMEOUT):
    """Refuse to let a gesture start while a slide iframe rebuild is in flight.

    Called from _dispatch_mouse on "mousePressed" only — that is the single
    choke point every synthetic gesture passes through (_click, drag, dblclick
    and anything added later), so a new primitive cannot reintroduce the bug
    by forgetting to wait. Move/release events are deliberately not guarded:
    they belong to a gesture whose press already passed this check, and an
    extra round trip per move would slow every drag for nothing.
    """
    deadline = time.time() + timeout
    while True:
        _, pending = _ready_probe()
        if not pending:
            return
        if time.time() >= deadline:
            raise RuntimeError(
                f"投影片 iframe 重建後 {timeout:.0f} 秒內沒有送出 runtime-ready，"
                "拒絕派送輸入事件（此時送出的事件會被靜默丟棄，"
                "手勢不會發生，之後的斷言會量到手勢前的狀態）"
            )
        time.sleep(0.05)


def _wait_frame_ready(timeout=_FRAME_READY_TIMEOUT):
    """Poll until the slide iframe exists, has a resolvable target, has
    rendered the selection-overlay host, AND has parsed the slide markup
    (a root <svg>). Re-resolved on every call — the target id changes
    across page navigations / slide changes, so it is never cached in a
    module variable.

    The selection host alone is not enough: it is appendChild'd by the
    runtime before bodyMarkup is parsed (NOOP-349 round 3), so a caller
    that only waited for the host could still race a marquee drag against
    an iframe with no <svg> yet. document.readyState is deliberately not
    checked here (round-3 plan §4.D) — it can sit at "interactive" for a
    long time on slow media/fonts, which would just move the timeout
    somewhere else without telling the caller anything about selection
    correctness.

    NOT sufficient before dispatching input. Both conditions above are true
    while selection-runtime.js is still between "markup parsed" and
    "addEventListener" — a real window, not a theoretical one — and a mouse
    event dispatched into it is dropped without a trace. Readiness for input
    is _require_runtime_ready() (enforced automatically for every gesture by
    _dispatch_mouse); this function answers only "is there a slide to look
    at", which is what selection()/_find_target_box() need.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        tid = _iframe_target_id()
        if tid:
            try:
                ready = _js_ro(
                    "document.querySelector('[data-comot-selection-host]') != null "
                    "&& document.querySelector('svg') != null",
                    target_id=tid,
                )
            except Exception:
                ready = False
            if ready:
                return tid
        time.sleep(0.3)
    raise RuntimeError(f"投影片 iframe 在 {timeout:.0f} 秒內沒有就緒（slide-frame / frameId / selection host / svg markup 其中一項沒出現）")


def _iframe_offset():
    rect = _js_ro(
        "(()=>{const f=document.querySelector('iframe.slide-frame');"
        "if(!f)return null;const r=f.getBoundingClientRect();return {x:r.x,y:r.y};})()"
    )
    if rect is None:
        raise RuntimeError("找不到 iframe.slide-frame（父文件）")
    return rect


def _find_target_box(tid, name_or_id):
    order = ["id", "name"] if name_or_id.startswith("el-") else ["name", "id"]
    expr = (
        f"(()=>{{const want={json.dumps(name_or_id)};const order={json.dumps(order)};"
        "let e=null;for(const kind of order){"
        "if(kind==='id'){e=document.getElementById(want);}"
        "else{e=Array.from(document.querySelectorAll('[data-comot-name]'))"
        ".find(x=>x.getAttribute('data-comot-name')===want)||null;}"
        "if(e)break;}"
        "if(!e)return null;const r=e.getBoundingClientRect();"
        "return {x:r.x,y:r.y,width:r.width,height:r.height};})()"
    )
    return _js_ro(expr, target_id=tid)


def _wait_chip_update(timeout=_CHIP_UPDATE_TIMEOUT):
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        text = (_js_ro("(document.querySelector('.status-selection-chip')||{}).textContent || ''") or "").strip()
        if text:
            return text
        time.sleep(0.1)
    return text


def open_deck():
    """Open (or reuse) the tab on CO_MOTION_QA_URL and wait for the deck to
    render. Returns {"url", "presentation_id", "slides"}."""
    url = _server_url()
    same = False
    try:
        cur = _current_tab()
        same = (cur.get("url") or "").rstrip("/") == url
    except Exception:
        same = False
    navigated = not same
    if navigated:
        _new_tab(url)
    _activate_current_tab()
    _wait_for_load()
    # --window-size gives Chromium a window, not a viewport (verified: it
    # undershoots by however tall the OS chrome is). This is the only way
    # that reliably lands on exactly 1440x900, and it persists across
    # browser-use calls since it's a CDP-level override, not a CLI flag.
    _cdp_ro("Emulation.setDeviceMetricsOverride", width=1440, height=900, deviceScaleFactor=1, mobile=False)
    # Installs the "runtime-ready" probe on the parent document. After a fresh
    # navigation the probe is necessarily younger than the iframe it has to
    # watch, so it cannot have observed that build starting — mark the window
    # open explicitly and wait it out, rather than letting the first gesture
    # of the session race a half-built runtime.
    _ready_probe(mark_pending=navigated)
    if navigated:
        _require_runtime_ready(_INITIAL_LOAD_TIMEOUT)
    _wait_frame_ready()
    return {
        "url": url,
        "presentation_id": os.environ.get("CO_MOTION_QA_PRESENTATION_ID", ""),
        "slides": slide_count(),
    }


def goto_slide(n):
    """Click the overview thumbnail for slide `n` (1-based). Returns the
    slide number shown afterwards."""
    box = _js_ro(
        f"(()=>{{const el=document.querySelector('.overview-thumb[aria-label=\"Slide {int(n)}\"]');"
        "if(!el)return null;const r=el.getBoundingClientRect();"
        "return {x:r.x+r.width/2,y:r.y+r.height/2};})()"
    )
    if box is None:
        raise RuntimeError(f"goto_slide: 找不到縮圖 Slide {n}")
    # Navigating rebuilds the srcdoc iframe, so the document that answers the
    # DOM checks in _wait_frame_ready() may be one whose pointer listeners are
    # not attached yet: the runtime appends the selection host and parses the
    # markup BEFORE addEventListener, and only then posts "runtime-ready".
    # Waiting on the DOM alone let a drag() issued right after goto_slide()
    # dispatch its mouse events into that gap, where they are dropped without
    # a trace — no gesture-start, no gesture-move, no gesture-end, and a
    # marquee that silently selects nothing (NOOP-349: F-15's B-2, 2/6 before
    # this wait, 6/6 after).
    _click(box["x"], box["y"])
    # Two waits, in this order, and both are needed.
    #
    # canvas.ts's render() `await fetchText()`s the slide markup BEFORE it
    # assigns frame.srcdoc, so the rebuild starts tens of milliseconds after
    # the click — later than the first poll below can possibly observe. Polling
    # only for "no rebuild in flight" would therefore sail straight through on
    # the pre-rebuild state and hand the caller an iframe that is about to be
    # thrown away, which is how a drag() right after goto_slide() ends up
    # dispatching into a document with no listeners.
    _wait_rebuild_started()
    # Then wait it out. Not "wait for a fresh runtime-ready": clicking the
    # thumbnail of the slide already on screen does not always replace the
    # srcdoc, and requiring a new one would hang forever on that no-op case.
    _require_runtime_ready()
    _wait_frame_ready()  # navigating rebuilds the srcdoc iframe -> new target id
    text = _js_ro("(document.querySelector('.slide-nav-position')||{}).textContent || ''") or ""
    m = _SLIDE_NAV_RE.search(text)
    if not m:
        raise RuntimeError(f"goto_slide: 無法解析頁碼：{text!r}")
    return int(m.group(1))


def slide_count():
    """Number of slides in the deck (parent-document overview list)."""
    return int(_js_ro("document.querySelectorAll('.overview-item').length"))


def select(name_or_id):
    """Click the element matched by `data-comot-name` (or `#id` for an
    `el-`-prefixed id) inside the slide iframe. Returns selection()."""
    tid = _wait_frame_ready()
    box = _find_target_box(tid, name_or_id)
    if box is None:
        names = _js_ro(
            "Array.from(document.querySelectorAll('[data-comot-name]')).map(e=>e.getAttribute('data-comot-name'))",
            target_id=tid,
        )
        raise RuntimeError(f"select: 找不到元素 {name_or_id!r}；本頁現有的 data-comot-name：{names!r}")
    off = _iframe_offset()
    cx = box["x"] + box["width"] / 2 + off["x"]
    cy = box["y"] + box["height"] / 2 + off["y"]
    _click(cx, cy)
    chip = _wait_chip_update()
    if not chip:
        # Round-5 plan contract: don't let an empty chip flow into
        # selection() and surface as a bare TypeError downstream (r4's
        # "'NoneType' object is not subscriptable") — report it here, where
        # we still know which element the click targeted.
        raise RuntimeError(
            f"select: 點擊 {name_or_id!r} 後等待 {_CHIP_UPDATE_TIMEOUT:g}s，選取 chip 仍為空"
            "（點擊可能沒有效果，或渲染被延後）"
        )
    return selection()


def selection():
    """Current selection: {"chip", "box", "handles"}. box/handles are in
    parent-document coordinates. Empty selection: {"chip": "", "box": None,
    "handles": {}}."""
    chip = (_js_ro("(document.querySelector('.status-selection-chip')||{}).textContent || ''") or "").strip()
    if not chip:
        return {"chip": "", "box": None, "handles": {}}
    tid = _wait_frame_ready()
    off = _iframe_offset()
    # Every `.handle` name (corners, rotate, the text-box width edges) is
    # always present in the DOM with display:none as its resting state; only
    # the ones applicable to the current selection get shown. Filter on
    # getComputedStyle, not the class list — showing/hiding is driven by
    # style.display writes on re-render, not a CSS class toggle.
    result = _js_ro(
        "(()=>{const host=document.querySelector('[data-comot-selection-host]');"
        "if(!host||!host.shadowRoot)return {box:null,handles:{}};"
        "const root=host.shadowRoot;const sel=root.querySelector('.sel');"
        "let box=null;if(sel){const r=sel.getBoundingClientRect();"
        "box={x:r.x,y:r.y,w:r.width,h:r.height};}"
        "const handles={};root.querySelectorAll('.handle').forEach(h=>{"
        "const name=h.getAttribute('data-comot-handle');if(!name)return;"
        "if(getComputedStyle(h).display==='none')return;"
        "const r=h.getBoundingClientRect();"
        "handles[name]=[r.x+r.width/2,r.y+r.height/2];});"
        "return {box:box,handles:handles};})()",
        target_id=tid,
    ) or {"box": None, "handles": {}}
    box = result.get("box")
    if box is not None:
        box = {"x": box["x"] + off["x"], "y": box["y"] + off["y"], "w": box["w"], "h": box["h"]}
    handles = {name: (xy[0] + off["x"], xy[1] + off["y"]) for name, xy in (result.get("handles") or {}).items()}
    return {"chip": chip, "box": box, "handles": handles}


_DRAG_SETTLE_TIMEOUT = 2.0
_DRAG_SETTLE_POLL = 0.1
_DRAG_SETTLE_STABLE_GAP = 0.1


def _wait_status_bar_settled(timeout=_DRAG_SETTLE_TIMEOUT):
    """Poll status_bar() until two reads at least _DRAG_SETTLE_STABLE_GAP
    apart return the same text, up to `timeout`. Never raises — PASS/FAIL is
    always decided by the case script's own assertions, not by this helper
    (round-3 plan §4.C); a caller that times out here just gets whatever the
    bar currently says, same as before this helper existed."""
    deadline = time.time() + timeout
    last = status_bar()
    last_read_at = time.time()
    while time.time() < deadline:
        time.sleep(_DRAG_SETTLE_POLL)
        cur = status_bar()
        now = time.time()
        if cur == last and (now - last_read_at) >= _DRAG_SETTLE_STABLE_GAP:
            return cur
        last, last_read_at = cur, now
    return last


def drag(from_xy, to_xy, steps=10):
    """CDP Input.dispatchMouseEvent pressed -> `steps` moved -> released, in
    parent-document coordinates. buttons=1 on every pressed/moved event is
    required — without it the page sees pointermove events with e.buttons==0
    and the drag gesture pipeline never engages. Raises ValueError when the
    total displacement is under 8px (below the app's 3px drag threshold,
    i.e. this would not register as a drag anyway).

    Before returning, waits (up to 2s) for the status bar text to stabilize
    (NOOP-349 round 3) — mouseReleased used to return immediately, racing
    every caller's next status_bar()/selection() read against the
    gesture-end -> host state update -> React re-render chain."""
    fx, fy = from_xy
    tx, ty = to_xy
    if math.hypot(tx - fx, ty - fy) < 8:
        raise ValueError("drag: 總位移小於 8px，等同沒有拖曳")
    _dispatch_mouse(type="mousePressed", x=fx, y=fy, button="left", buttons=1, clickCount=1)
    for i in range(1, steps + 1):
        x = fx + (tx - fx) * i / steps
        y = fy + (ty - fy) * i / steps
        _dispatch_mouse(type="mouseMoved", x=x, y=y, button="left", buttons=1)
        time.sleep(0.016)
    _dispatch_mouse(type="mouseReleased", x=tx, y=ty, button="left", buttons=0, clickCount=1)
    _wait_status_bar_settled()


def dblclick(x, y):
    """Two pressed/released pairs at (x, y) in parent-document coordinates,
    clickCount 1 then 2."""
    _dispatch_mouse(type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=1)
    _dispatch_mouse(type="mouseReleased", x=x, y=y, button="left", buttons=0, clickCount=1)
    _dispatch_mouse(type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=2)
    _dispatch_mouse(type="mouseReleased", x=x, y=y, button="left", buttons=0, clickCount=2)


def slide_svg(n):
    """The raw source of slides/NNN.svg, read back from the server (not the
    DOM) via GET /api/raw/slides/NNN.svg."""
    return _http_get(f"{_server_url()}/api/raw/slides/{int(n):03d}.svg")


def save_state():
    """GET /api/save-state: {"known": True, "dirty": bool, "fileName": str}
    or {"known": False}."""
    return json.loads(_http_get(f"{_server_url()}/api/save-state"))


def active_element():
    """Parent document's document.activeElement, description. When it is
    the slide IFRAME, descends one level into the slide frame's own
    activeElement instead (in_iframe: True either way in that case)."""
    info = _js_ro(
        "(()=>{const e=document.activeElement;if(!e)return null;"
        "return {tag:e.tagName,class:e.className||'',id:e.id||null};})()"
    )
    if info is None:
        return {"tag": "", "class": "", "id": None, "in_iframe": False}
    if info.get("tag") != "IFRAME":
        info["in_iframe"] = False
        return info
    tid = _iframe_target_id()
    if tid:
        inner = _js_ro(
            "(()=>{const e=document.activeElement;if(!e)return null;"
            "return {tag:e.tagName,class:e.className||'',id:e.id||null};})()",
            target_id=tid,
        )
        if inner is not None:
            inner["in_iframe"] = True
            return inner
    info["in_iframe"] = True
    return info


def status_bar():
    """footer.status.status-bar's full textContent (chip, shortcut hints,
    page number)."""
    return _js_ro("(document.querySelector('footer.status.status-bar')||{}).textContent || ''") or ""


def console_errors():
    """Console error messages seen since the last call — parent document and
    the slide iframe both included.

    Known limits (see qa/README.md): iframe errors are only captured after
    the iframe session below has been attached at least once (errors before
    the first console_errors() call on a given iframe target are missed);
    this shares the daemon's event buffer with wait_for_network_idle(), so
    the two are mutually exclusive within one polling window.
    """
    session_path = _qa_dir() / "out" / ".qa-session.json"
    state = {}
    if session_path.exists():
        try:
            state = json.loads(session_path.read_text())
        except Exception:
            state = {}
    tid = _iframe_target_id()
    if tid and state.get("iframe_target") != tid:
        try:
            sid = _cdp_ro("Target.attachToTarget", targetId=tid, flatten=True)["sessionId"]
            _cdp_ro("Runtime.enable", session_id=sid)
            state = {"iframe_target": tid, "iframe_session": sid}
            session_path.parent.mkdir(parents=True, exist_ok=True)
            session_path.write_text(json.dumps(state))
        except Exception:
            pass
    errors = []
    for event in _drain_events():
        if event.get("method") != "Runtime.consoleAPICalled":
            continue
        params = event.get("params", {})
        if params.get("type") != "error":
            continue
        text = " ".join(str(a.get("value", a.get("description", ""))) for a in params.get("args", []))
        errors.append(text)
    return errors


def shot(name):
    """Screenshot to qa/out/<name>.png (not version-controlled). `name` is
    restricted to [A-Za-z0-9._-]+ so this can never write outside qa/out/."""
    if not _NAME_RE.match(name):
        raise ValueError(f"shot: name 只能是 [A-Za-z0-9._-]+，收到 {name!r}")
    out_dir = _qa_dir() / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return _capture_screenshot(str(out_dir / f"{name}.png"))
