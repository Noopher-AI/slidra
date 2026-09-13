# Sandbox QA layer

For agents verifying Slidra in a sandbox pod: one command boots Slidra, then
`browser-use` plus Slidra-specific helpers drive the app, read back slide files and
state, keeping the same browser session across multiple Bash calls. This is the
verification tool for fix tickets.

## 1. How to bring up the environment

```bash
npm run verify:setup -- --qa --no-open
source .quickstart/qa/qa.env
browser-use < qa/cases/smoke.py
```

The first line prints the result of `browser-use --doctor`; exit code 0 means the
daemon is connected and the current active page is Slidra. The second line
imports `BU_CDP_URL`, `BH_AGENT_WORKSPACE`, `SLIDRA_QA_URL`,
`SLIDRA_QA_PRESENTATION_ID`, `BH_RUNTIME_DIR`, and `BH_TMP_DIR` into the current
shell; every subsequent independent `browser-use` call then attaches to the same
browser tab.

`BH_RUNTIME_DIR` must be a short path (`--qa` hardcodes it to
`/tmp/slidra-qa-$(id -u)`), not somewhere under `.quickstart/`: the daemon's IPC
socket uses `AF_UNIX`, and this sandbox pod's repo path (including the workspace
prefix) plus the socket filename would exceed Linux's 108-byte `sun_path` limit,
producing `fatal: AF_UNIX path too long` and failing to start at all. Never change
this back to a path under the repo when composing your own commands.

To tear down:

```bash
./scripts/quick_start.sh --qa-stop
```

This shuts down both the background `slidra serve` process left by `--qa` and
Chromium (both are started via `setsid` as their own process group, and `kill`
signals the whole PGID, not just the wrapper). Re-running verification is routine;
when `--qa` detects an existing QA environment still alive, it tears it down first
and restarts on its own — no manual cleanup needed.

## 2. Fixed structure of a case script

Every case script (`qa/cases/<id>.py`) has a fixed three-part structure:

```python
def setup():
    ...  # preconditions like open_deck()

def act():
    ...  # the action sequence

def assert_():
    ...  # checks; call the fail helper before sys.exit(1) if any check fails

def main():
    setup(); act(); assert_()
    print("PASS: <id>")

main()  # do not use `if __name__ == "__main__":` — browser-use runs the stdin
        # script via exec(code, globals()), and globals()['__name__'] is
        # "browser_harness.run", never "__main__", so this guard would never
        # fire (qa/cases/smoke.py follows this exact structure — copy from it
        # directly).
```

How to run:

```bash
browser-use < qa/cases/<id>.py
```

A non-zero exit code means FAIL. The first line of output is always `PASS: <id>` or
`FAIL: <which check> expected=<…> actual=<…>`, optionally followed by the measured
raw values — the whole block can be pasted directly into a review comment without
further transcription.

## 3. Success criterion: PASS on the PR branch, FAIL on that PR's base

To verify a fix ticket, run the same case script once on each of two commits, and
paste both raw outputs into the comment, labeled with the corresponding commit:

```bash
git checkout <PR branch>
npm run verify:setup -- --qa --no-open
source .quickstart/qa/qa.env
browser-use < qa/cases/<id>.py   # expected PASS
./scripts/quick_start.sh --qa-stop

git checkout <base>
npm run verify:setup -- --qa --no-open
source .quickstart/qa/qa.env
browser-use < qa/cases/<id>.py   # expected FAIL (bug still present)
./scripts/quick_start.sh --qa-stop
```

Only when the PR branch PASSes and the base FAILs does the ticket actually count as
fixed — if both PASS, the case script isn't asserting the actual bug; if both FAIL,
the fix didn't take effect.

## 3.5 Two traps that make PASS/FAIL meaningless

Neither of these turns any assertion red — instead they make the assertions measure
the wrong thing and report a result that looks perfectly normal. One case script hit
both of these and paid for it across several review rounds.

**(1) Input events silently dropped.** Slides run inside a sandboxed srcdoc
iframe that gets fully rebuilt on every page change. `selection-runtime.js` sets up
the selection host and parses the markup first, only calls `addEventListener`
**after** that, and only fires `runtime-ready` at the very end. Any CDP input event
dispatched during that gap lands on a document with no pointer listener at all, and
is silently dropped — no error, no console message, no gesture-start/move/end. The
gesture effectively never happened, and the subsequent assertion measures the
pre-gesture state. `agent_helpers.py` now hard-blocks on every mousePressed inside
`_dispatch_mouse()` (via `_require_runtime_ready()`), so new primitives don't need to
remember to wait — but **remember this when composing your own CDP calls**. The
signal that an iframe can accept input is `runtime-ready`, not whether the DOM
contains an `<svg>`.

**(2) A dirtied deck.** As soon as any gesture actually moves an element, the
served deck diverges from `demo/` — and **stays diverged**: `scripts/quick_start.sh` never
repacks the demo automatically, and `open_deck()` only compares the URL, it never
reloads. Every subsequent case script then judges against a deck whose positions are
wrong. One F-series case's "rectangle covers three lines of text but not the
title" check, once the title got dragged into the selection box, would very
consistently report 4 elements — which looked exactly like a broken hit-test in the
product.

After running any case that writes files, or any time a result looks off, first
confirm the deck is in its original state:

```bash
slidra cat "$SLIDRA_QA_PRESENTATION_ID" slides/003.svg | diff - demo/slides/003.svg
```

If it doesn't match, reopen a fresh copy and rerun:

```bash
ID=$(slidra open .quickstart/demo.slidra | grep -o '"id"[^,}]*' | sed 's/.*"\([^"]*\)"$/\1/')
```

## 4. How to write around flaky behavior

A case script only requires a **PASS on the PR branch** — a FAIL on base doesn't
mean the case script has to assert "this can never happen." For behavior known to
be occasionally flaky, rewrite the assertion defensively instead of deleting the
case. For example, one double-click case with an occasional stray blue selection
flash doesn't assert "the input box must always appear" — instead it asserts "after
the double-click, `window.getSelection().toString()` is empty": turning the
uncertainty of "will it happen" into the stably verifiable statement "if it does
happen, it must not leak into a visibly broken state."

## 5. Round-3 exploratory reports (reusing `qa/visual-qa.md`)

Round-3 exploratory reports (no corresponding case script, just looking at
screenshots for problems) reuse the criteria and format in
[`visual-qa.md`](visual-qa.md) rather than redefining them here:

- **Five criteria categories**: insufficient foreground/background contrast,
  insufficient state-indicator contrast, no visual feedback after completing an
  action, unbalanced space allocation, inconsistent editing-state
  recognizability. If you can't say what the user would actually experience as a
  result, it doesn't count.
- **Report format**: Markdown table
  `| scenario id | criteria category | user impact | screenshot filename |`,
  **sorted ascending by the scenario id's ASCII string order** (running the same
  input twice should diff clean).
- **Scenarios not to judge**: `new-slide-menu`, `shape-menu`,
  `insert-shape-menu` — these three are transitional in-between screens, and
  judging them tends to produce false positives.

## 6. `browser-use` version and upgrade notes

This round (including the helper implementation and verification) was written and
tested against **`browser-use 0.1.13`**. `qa/agent_helpers.py` only uses the public
names from `browser_harness.helpers` (`cdp`, `current_tab`, `new_tab`,
`wait_for_load`, `drain_events`, `http_get`, `capture_screenshot`); these are
relatively stable core primitives, but after any upgrade the first thing to do is
still run:

```bash
browser-use < qa/cases/smoke.py
```

A PASS means these signatures haven't had a breaking change.

## Known limitations

- **`console_errors()` only covers iframe errors that occur after attaching.** The
  daemon only opens the `Runtime` domain for the currently attached page session;
  seeing the slide iframe's console requires the helper to attach a separate
  session, and that attachment happens on the first call to `console_errors()` —
  any iframe error before that (e.g. between a page change rebuilding the iframe
  and the next call) is missed. The parent document's errors aren't affected by
  this and are always visible.
- **`console_errors()` and the core `wait_for_network_idle()` are mutually
  exclusive.** Both rely on `drain_events()`, and `drain_events()` clears the
  daemon's event buffer — using both in the same flow means whichever is called
  second won't see events the other one already drained.
- **`qa/cases/smoke.py` only supports the demo deck** (`scripts/quick_start.sh --qa`
  without `--blank`). The blank deck has only 1 page and no
  `data-slidra-name="title"` element, so the `slide_count() == 4` assertion fails
  first, with a message suggesting "please don't add `--blank`."
- **`qa/cases/*.py` are not part of CI and are not a merge gate** — these
  scripts are designed to be run manually by an agent during review, not as part
  of the automated test suite.
- **`--qa`'s Chromium launch flags include container flags like
  `--disable-dev-shm-usage`**: in a container, `/dev/shm` is often only 64MB, and
  without this flag the renderer can slow down or hang under heavy interaction,
  showing up as CDP calls timing out or clicks being sent with no visible
  response. Read-only CDP/JS calls can separately have their timeout tuned via
  `SLIDRA_QA_IPC_TIMEOUT` (seconds, default 20); a non-numeric or non-positive
  value errors out immediately.
- `browser-use --doctor` always prints a line
  `[FAIL] Browser Use cloud auth — optional`; this is expected — `--doctor`
  itself still exits with code `0`, and it doesn't mean the QA environment failed
  to start.
