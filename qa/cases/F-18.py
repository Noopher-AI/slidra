"""F-18: an export error message gets pushed off screen; also exercises one
successful export along the way.

Depends on the sandboxed QA layer (`scripts/quick_start.sh --qa` starts the environment,
`qa/agent_helpers.py` provides `open_deck()`, `browser_harness.helpers` provides
`js(expression, target_id=None)`); CLI calls go straight through subprocess to
`slidra` (`--json` gives a structured result; format documented in
docs/spec/cli.md's "CommandResult" section:
`{"ok":bool,"data":...,"message":str,"failureKind"?:str}`).

Criteria (verbatim from the acceptance criteria): trigger one export failure,
`.export-status-error`'s `getBoundingClientRect().left >= 0` and its first line is
visible; then do one successful export and confirm the file exists.

**How to produce a long enough failure message**: the demo doesn't have an existing
fixture for "the backend produces a long message" (switching to a shared fixture
would affect other existing tests), so the CLI is used to insert a media placeholder
element on demo slide 1 with a deliberately long `--media` value and an unsupported
`.xyz` extension, then an `family=media effect=play` effect is added to it --
`player-plan.ts`'s `mediaKindFor()`, on hitting an unsupported extension during
export, throws a message along the lines of "element '<id>''s data-slidra-media
'<the literal long string>' has extension '.xyz', which isn't a supported media
format...", far longer than `.export-status`'s current `nowrap` layout can display,
which is enough to reproduce F-18 (`docs/spec/cli.md` confirms `--media` accepts any
value for any kind, unvalidated; `effect add --family media --effect play` works the
same way).

**Cleanup** (qa/README.md §3.5, "a dirty presentation"): after measuring, undo both
changes with `effect remove` + `element delete` before doing the successful-export
measurement -- otherwise this presentation would keep carrying the broken effect and
every subsequent case script would be judging against the wrong content. **Byte-for-
byte identity is not required**: after `effect remove` deletes the last item in an
effect list, the container itself
(`<metadata><slidra:effects .../></metadata>`) is left behind (checked manually --
this is existing behavior of `effect remove`/`effect add`, not something left behind
by this script; `effect list` against it still correctly reports `effects: []`, not
an error, and no other case script reads slide 001.svg's effect list). This empty
shell doesn't affect any behavior, so cleanup only asserts "the inserted rect
element's id and the real `slidra:effect ` entry are both gone", not a byte-for-byte
comparison.
"""

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

FAILURES: list[str] = []


def check(label: str, ok: bool, actual: object) -> None:
    print(f"{'PASS' if ok else 'FAIL'} {label} {actual!r}")
    if not ok:
        FAILURES.append(label)


def slidra(*args: str) -> dict:
    result = subprocess.run(
        ["slidra", *args, "--json"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0 and not result.stdout.strip():
        raise RuntimeError(f"slidra {' '.join(args)} failed: exit={result.returncode} stderr={result.stderr!r}")
    return json.loads(result.stdout)


def main() -> int:  # noqa: PLR0915 - a single linear flow; splitting into functions would make the "create -> measure -> restore -> measure again" steps harder to follow
    presentation_id = __import__("os").environ["SLIDRA_QA_PRESENTATION_ID"]
    slide_path = "slides/001.svg"

    original = subprocess.run(
        ["slidra", "cat", presentation_id, slide_path],
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout

    if "slidra:effect " in original:
        print(
            "FAIL slides/001.svg already had a pre-existing slidra:effect before this run started "
            "(this script assumes a clean demo starting point, where the newly added effect is "
            "index 1). Check whether the QA environment is carrying leftovers from a previous "
            "failed run, or run against a fresh demo instead."
        )
        return 1

    open_deck()  # noqa: F821

    long_media = "placeholder-" + ("長訊息驗證用填充字元" * 20) + ".xyz"
    inserted = slidra(
        "element", "insert", "rect", presentation_id, slide_path,
        "--x", "0", "--y", "0", "--width", "10", "--height", "10",
        "--media", long_media,
    )
    if not inserted.get("ok"):
        print(f"FAIL element insert failed: {inserted}")
        return 1
    element_id = inserted["data"]["elementId"]

    effect_added = slidra(
        "effect", "add", presentation_id, slide_path, element_id,
        "--family", "media", "--effect", "play",
    )
    if not effect_added.get("ok"):
        print(f"FAIL effect add failed: {effect_added}")
        # The inserted element is already written to the file, so clean it up even
        # though this step failed before returning.
        slidra("element", "delete", presentation_id, slide_path, element_id)
        return 1

    try:
        js(  # noqa: F821
            "document.querySelector('.titlebar-button.export-toggle-button').click()"
        )
        deadline = time.time() + 5.0
        menu_ready = False
        while time.time() < deadline:
            if js("!!document.querySelector('[role=\"menu\"]')"):  # noqa: F821
                menu_ready = True
                break
            time.sleep(0.2)
        if not menu_ready:
            print("FAIL the Export menu didn't appear within 5 seconds")
            return 1

        js(  # noqa: F821
            "Array.from(document.querySelectorAll('.export-menu-item'))"
            ".find(b=>b.textContent.includes('One page per slide')).click()"
        )

        deadline = time.time() + 30.0
        error_seen = False
        while time.time() < deadline:
            if js("!!document.querySelector('.export-status-error')"):  # noqa: F821
                error_seen = True
                break
            time.sleep(0.3)
        if not error_seen:
            print("FAIL .export-status-error didn't appear within 30 seconds (the expected export failure didn't happen)")
            return 1

        error_text = js("document.querySelector('.export-status-error').textContent")  # noqa: F821
        check("Error message contains the synthesized long data-slidra-media value", long_media in (error_text or ""), (error_text or "")[:120])

        geometry = js(  # noqa: F821
            "(()=>{const el=document.querySelector('.export-status-error');"
            "const r=el.getBoundingClientRect();return {left:r.left,top:r.top};})()"
        )
        check("Error block left >= 0 (not pushed off screen)", geometry["left"] >= 0, geometry)
        check("Error block top >= 0 (first line lands within the viewport)", geometry["top"] >= 0, geometry)
    finally:
        # Cleanup: regardless of what was measured above, remove the inserted
        # effect/element first -- the presentation can't be left carrying this
        # synthesized bad data for the next case script.
        slidra("effect", "remove", presentation_id, slide_path, "1")
        slidra("element", "delete", presentation_id, slide_path, element_id)

    restored = subprocess.run(
        ["slidra", "cat", presentation_id, slide_path],
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout
    # Not a byte-for-byte comparison: `effect remove` leaves an empty
    # `<slidra:effects>` container behind after removing the last item (see the file
    # header docstring) -- this is existing behavior, not something left behind by
    # this script. Only confirm that the inserted element and this synthesized
    # effect are both really gone.
    check("Restored file no longer contains the inserted element id", element_id not in restored, element_id in restored)
    check("Restored file no longer contains a slidra:effect entry (an empty container is fine)", "slidra:effect " not in restored, "slidra:effect " in restored)

    # Dismiss any leftover error panel/menu state so the successful export below
    # starts from a clean slate.
    js(  # noqa: F821
        "(()=>{const d=document.querySelector('.export-status-dismiss');if(d)d.click();})()"
    )

    js("document.querySelector('.titlebar-button.export-toggle-button').click()")  # noqa: F821
    deadline = time.time() + 5.0
    menu_ready = False
    while time.time() < deadline:
        if js("!!document.querySelector('[role=\"menu\"]')"):  # noqa: F821
            menu_ready = True
            break
        time.sleep(0.2)
    if not menu_ready:
        print("FAIL the Export menu didn't appear within 5 seconds (successful-export path)")
        return 1
    js(  # noqa: F821
        "Array.from(document.querySelectorAll('.export-menu-item'))"
        ".find(b=>b.textContent.includes('One page per slide')).click()"
    )

    deadline = time.time() + 30.0
    done_seen = False
    while time.time() < deadline:
        if js("!!document.querySelector('.export-status-done a')"):  # noqa: F821
            done_seen = True
            break
        time.sleep(0.3)
    if not done_seen:
        print("FAIL .export-status-done didn't appear within 30 seconds (the successful export after restoring didn't happen)")
        return 1

    href = js("document.querySelector('.export-status-done a').getAttribute('href')")  # noqa: F821
    base_url = __import__("os").environ["SLIDRA_QA_URL"].rstrip("/")
    download_url = href if href.startswith("http") else f"{base_url}{href if href.startswith('/') else '/' + href}"
    with urllib.request.urlopen(download_url, timeout=30) as response:  # noqa: S310 - always points at the local QA server
        payload = response.read()
    check("Downloaded export file starts with %PDF", payload[:4] == b"%PDF", payload[:20])
    check("Downloaded export file is > 1000 bytes", len(payload) > 1000, len(payload))

    print(f"Summary: {len(FAILURES)} failure(s)" if FAILURES else "Summary: all passed")
    return 1 if FAILURES else 0


raise SystemExit(main())
