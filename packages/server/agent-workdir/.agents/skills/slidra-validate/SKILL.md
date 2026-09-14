---
name: slidra-validate
description: Review the whole deck or a specified page: run slidra validate, then read through for typos and animation order the commands can't catch, pin each problem as a comment and interpret it for the author; comment only, never edit. Use when the author's message starts with /slidra-validate or asks to "check", "give a health check", or "validate" the deck
---

# Review slides

You are the **reviewer**. The rules that actually count are the `slidra validate` command (thresholds and rules live in the CLI, not in your eye); your job is to run it, translate `errors[]` into words the author understands, pin them as comments, then read through once to catch the two kinds of problems commands cannot see. **Report and comment only; do not modify any content** — fixing is the author's decision, or `slidra-build` fixes it itself.

## Input

- Target: a page number (`3`), a range (`2-5`), or omitted = the whole deck.
- Optional: "no comments" — report in the conversation only, no `comment add`.

## Steps

1. `slidra ls <presentation-id> slides` to confirm the target page exists; if not, reply "This deck only has N pages" and stop.
2. **Run validation**: whole deck `slidra validate <presentation-id>`; a specified page means `slidra validate <presentation-id> slides/00N.svg` per page. A non-zero exit code means **there are errors**, not that the command is broken; `data` looks like:

   ```json
   { "checked": 6, "errors": [ { "slide": "slides/002.svg", "element": "el-abc", "rule": "text.bullet-length", "actual": "37 chars", "limit": "≤ 32 chars", "message": "Page 2 bullet 3 is 37 chars, limit 32" } ] }
   ```

   When the message tail carries "(no plan/ plan file, only geometry and skeleton checked)", text volume and type/color were not validated; note in the report that full validation requires running `/slidra-plan` first.
3. **Read through**: `slidra cat <presentation-id> slides/00N.svg` and `slidra effect list <presentation-id> slides/00N.svg` per page (a non-zero exit code means this page has no animation, not an error). Catch only the two kinds the commands can't:
   - **Typos**: obvious misspellings or dropped characters in text content.
   - **Animation order disagrees with layout order**: the effects' playback order doesn't match the visual top-to-bottom, left-to-right order of the elements on screen.
   For rule-based judgments, `errors[]` is always authoritative; what the command didn't report is not a violation.
4. **Comment**: one per finding, `slidra comment add <presentation-id> <slide> <element or page> '<rule>: <actual> vs limit <limit>'` (for read-through findings write `typo: …` / `animation order: …`); when `element` is `null` or no specific element can be found, use `page`. When the author said "no comments", skip this. Comment text must not contain half-width single quotes. Never touch existing comments.
5. **Report**: in the format below. What each `rule` checks and how the author usually fixes it: see the table in section 9 of `reference/slide-design.md`; group by the `rule` prefix and point out which kind to fix first — usually `text.`.

## Report format

One line per page: `Page N (slides/00N.svg): pass` or `Page N (slides/00N.svg): fail — <rule>: <actual> vs limit <limit>; …` (using `message`'s text directly is fine).
Final line: `N pages total, M passed; most failures are <rule prefix>`, plus one sentence on what to fix first. When nothing was found, report "Review complete, no problems found". Without a plan file, add a sentence stating the validation scope.
