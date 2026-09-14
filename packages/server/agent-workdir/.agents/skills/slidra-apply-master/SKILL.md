---
name: slidra-apply-master
description: Sweep a template's just-saved change onto every existing slide that was made from it — the deck has no sync mechanism (a template is dead once copied), so this is how "update the logo/footer everywhere" actually happens. Use when the message starts with /slidra-apply-master
---

# Apply a template change to existing slides

The editor's "Let the agent update the slides" button sends this skill's slash command with the template's path (and name, if it has one) already filled in — never ask the author which template, and never ask which slides; the answer is always "all of them, right now."

## Steps

1. **Read the template**: `slidra cat <presentation-id> <template-path>` — this is the target state every existing slide's copy of it should now match.
2. **List every slide**: `slidra ls <presentation-id> slides`. There is no recorded link from a slide back to the template it was made from (ADR-0013: a template is dead the moment it's copied) — and `slide add --template` re-mints a fresh element id for every element it copies, so **element ids never match between a template and a slide made from it**. Match elements by `data-slidra-name` instead (unaffected by the copy — only `id` is regenerated); an element with no name, match by role and position (the same background rect, the same corner logo, the same footer text) the same way `/slidra-style` matches "the title" when nothing is explicitly named.
3. **For each slide, in order**:
   - `slidra cat <presentation-id> slides/00N.svg`.
   - For every template element you can match to one on this slide, compare it: text content, `fill`/`stroke`/font attributes, position, size. A template element with nothing to match on this slide means the slide diverged further already (that element was deleted from that page, or the page never had it) — leave it alone, note it in the report, do not create a new element to compensate.
   - Write only the elements that actually differ, using the ordinary command for what changed (`text set`, `element style set`, `element move`/`scale`/`rotate`, `slide style set` for the page background). Try the plain command first; a locked element refuses it with an error naming `--force` — add `--force` and resubmit that one write. Never add `--force` pre-emptively to a write that wasn't refused.
   - An element unchanged from the template needs no write at all — don't touch it just because it's part of the sweep.
4. **One turn, start to finish**: every slide in the same reply, the same history group the author's own edits share (`AGENTS.md`'s "working conventions") — the whole point of asking the agent instead of clicking through each page by hand is that it lands as one undo step. Do not stop partway to ask "should I continue?" or "here's slide 3, want me to keep going?"; only stop early for the same two reasons any turn does (a decision only the author can make, or the same failure twice).

## Wrap-up

Before replying, run `slidra validate <presentation-id>` once and put the result on the first line of the report (see "finishing conditions" in `AGENTS.md`); fix and re-validate until it reaches 0 in this same turn.

## Report format

List the slides actually changed and what changed on each (element id, attribute, old → new); list any slide left alone because the matching element was already missing. A slide that already matched the template needs no line of its own beyond "already up to date" — don't pad the report with a change that didn't happen.
