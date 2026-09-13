"""F-13: the left-column thumbnail shows a "✦ n" badge for how many effects a slide has.

Depends on the sandboxed QA layer (`scripts/quick_start.sh --qa` starts the environment,
`qa/agent_helpers.py` provides the fixed primitives listed below) -- this script only
uses this list of primitives and does not add any new browser-interaction primitive:

    open_deck() / shot()

Plus the public core primitive `js()` that `browser_harness.helpers` itself injects
(not added by `agent_helpers.py` -- see that file's header comment: "every top-level
name not starting with '_' becomes a global... the same way core helpers like
js()/cdp() are"): `agent_helpers.py` has no primitive for reading a thumbnail badge's
textContent, so this script reads the DOM directly via `js()` instead of adding one.

There's also one external setup step: calling `node_modules/.bin/slidra effect add`
directly to add an effect to the slide 1 title (`el-title`) -- this "action" is part of
what the acceptance criteria are testing, not a browser gesture. After the CLI writes
the file, the server's `fs.watch(workDir)` (packages/server/src/watch.ts) broadcasts
`presentation-changed`, the same path a normal GUI-driven change takes (`slidra cat
"$SLIDRA_QA_PRESENTATION_ID" slides/001.svg` goes through the same work dir; this
path has already been verified in qa/README.md §1).

Criteria: demo/slides/003.svg's metadata carries three `<slidra:effect>` entries (one
enter effect per bullet), and demo/slides/001.svg has no effect list at all -- so slide
3's thumbnail should show "✦ 3" and slide 1's should show no marker. After adding one
effect to slide 1's title, slide 1's thumbnail should switch to showing "✦ 1". All
three badge reads use short polling (rather than a fixed sleep or a single immediate
read): `loadEffectCount()` (overview.ts) is an async fetch, and `open_deck()` only
guarantees `.overview-item` exists, not that the badge's fetch has already landed; on
top of that, adding an effect adds another 100ms of server-side debounce
(watch.ts's DEBOUNCE_MS).

If the first assertion (slide 1 has "no marker") unexpectedly fails, first check
whether the local presentation is still in its pristine state (qa/README.md §3.5,
"a dirty presentation") -- that would mean a previous run failed partway through and
left `slides/001.svg` already carrying an effect, so a fresh clean presentation is
needed before rerunning.
"""

import os
import subprocess
import time

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def badge_text(slide_number: int) -> object:
    """The textContent of `.overview-effect-badge` inside `.overview-item`
    (1-based `slide_number`); returns `None` if the badge element doesn't exist."""
    return js(  # noqa: F821 - public core primitive from browser_harness.helpers
        "(() => {"
        f"const li = document.querySelectorAll('.overview-item')[{int(slide_number) - 1}];"
        "const badge = li && li.querySelector('.overview-effect-badge');"
        "return badge ? badge.textContent : null;"
        "})()"
    )


def wait_for_badge(slide_number: int, expected: str, timeout: float = 5.0) -> object:
    """Poll `badge_text(slide_number)` until it equals `expected` or times out,
    returning the last value read (on timeout that's just the unexpected value,
    which is fed straight into check() for printing)."""
    deadline = time.monotonic() + timeout
    actual = badge_text(slide_number)
    while actual != expected and time.monotonic() < deadline:
        time.sleep(0.1)
        actual = badge_text(slide_number)
    return actual


def main() -> int:
    open_deck()  # noqa: F821

    before_1 = wait_for_badge(1, "")
    check("Slide 1 thumbnail has no ✦ marker (no effects on base)", before_1 == "", before_1)
    before_3 = wait_for_badge(3, "✦ 3")
    check("Slide 3 thumbnail shows ✦ 3 (demo/slides/003.svg carries three <slidra:effect>)", before_3 == "✦ 3", before_3)
    shot("F-13-before")  # noqa: F821

    presentation_id = os.environ["SLIDRA_QA_PRESENTATION_ID"]
    result = subprocess.run(
        [
            "node_modules/.bin/slidra",
            "effect",
            "add",
            presentation_id,
            "slides/001.svg",
            "el-title",
            "--family",
            "enter",
            "--effect",
            "fade",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"FAIL setup: `slidra effect add` failed stdout={result.stdout!r} stderr={result.stderr!r}")
        return 1

    after_1 = wait_for_badge(1, "✦ 1")
    check("After adding one effect to slide 1's title, its thumbnail shows ✦ 1", after_1 == "✦ 1", after_1)
    shot("F-13-after")  # noqa: F821

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


# browser-use runs the stdin script via exec(code, globals()); globals()['__name__']
# is "browser_harness.run", never "__main__", so the `if __name__ == "__main__"` guard
# would never fire (qa/README.md §2). Call main() unconditionally instead and let
# the caller's process exit code carry the result.
raise SystemExit(main())
