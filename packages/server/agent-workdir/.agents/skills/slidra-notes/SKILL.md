---
name: slidra-notes
description: Fill in colloquial, read-aloud-ready speaker notes per page, with an optional total or per-page duration. Use when the user says "add notes", "write the script", "speaker notes", "N minutes total", "about how long should this page take", or the message starts with /slidra-notes
---

# Write speaker notes

Notes are a colloquial, first-person script you can read aloud: claim first, then evidence, then the bridge to the next page; reciting the slide's own text does not count as a script.

## Input

- Target: one page or all pages. When unspecified, first `slidra ls <presentation-id> slides` to see the current state, ask the user which page or all, and issue no write commands until it's clear.
- Optional: a total duration (e.g. "10 minutes total") or a per-page duration.

## Steps

1. **The specified page does not exist**: report "This deck only has N pages"; do not execute.
2. **Read the content**: `slidra cat <presentation-id> slides/00N.svg` per page; extract the title and key points.
3. **The page already has notes** (non-empty `<slidra:notes>` in the `cat` output): show the existing content to the user first and ask whether to overwrite or keep — `slide notes set` overwrites the whole file; there is no append.
4. **Write the notes**: `slidra slide notes set <presentation-id> slides/00N.svg '<colloquial script>'`. One command per page; confirm one page before doing the next. Avoid half-width single quotes in the script (e.g. rephrase English possessives).
5. **A duration was given**: total seconds ÷ page count estimates seconds per page (a per-page duration counts only that page); estimate script length at roughly 240 colloquial Chinese characters per minute; list the estimated seconds per page in the report.
6. **Asked to clear**: `slidra slide notes set <presentation-id> slides/00N.svg ''` (an empty string is legal).
7. **Verify**: `cat` and read back to confirm `<slidra:notes>` has content.

## Wrap-up

After making changes, before replying, run `slidra validate <presentation-id>` once (only that page if only one page changed) and put the result on the first line of the report; if `errors` is not empty, fix and re-validate, ending this round only at 0 errors (see "wrap-up conditions" in `AGENTS.md`).

## Report format

Per page: page path, note content (or a summary), and estimated seconds when a duration was requested. When a page was paused because it already had notes, show the current content and wait for the user's confirmation.
