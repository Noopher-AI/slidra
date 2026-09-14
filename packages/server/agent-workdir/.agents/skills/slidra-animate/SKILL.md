---
name: slidra-animate
description: Add sequential-reveal animation effects and page transitions to a specific page or the whole deck; can be conservative or lively. Use when the user says "add animations", "reveal in sequence", "one by one", "add transitions", or the message starts with /slidra-animate
---

# Add animation effects

The sequential-reveal order is fixed: "title first, bullets one by one, image/table/chart last" — unless the user specifies otherwise. Principles for segmenting and grouping: section 5 of `reference/slide-design.md`.

## Input

- Target: a specific page (`slides/00N.svg`) or "the whole deck". When unspecified, first run `slidra ls <presentation-id> slides` to see the current state, ask the user which page or the whole deck, and issue no write commands until it's clear.
- Style (optional): "conservative" or "lively"; when unspecified, use the defaults.

## Steps

1. **The specified page does not exist**: report "This deck only has N pages"; do not execute and do not fall back to the closest page.
2. **Read the page structure**: `slidra cat <presentation-id> slides/00N.svg`; order elements by `data-slidra-role`, `data-slidra-name`, `font-size`, and `y` coordinate: title → bullets one by one → image/table/chart. Whether something gets an animation depends on its role (section 5.2): `garnish`, `background`, the footer, and elements without `data-slidra-name` that look decorative (full-page `<rect>`, lines, circles) all stay on the first frame.
3. **If the page already has effects, look at the current state first**: `slidra effect list <presentation-id> slides/00N.svg`; read before acting.
   - User wants a "redo": `slidra effect remove <presentation-id> slides/00N.svg <all 1-based indices, comma-separated>`, then re-add per step 4.
   - User wants to "fill in" gaps: only `effect add` for the missing elements; use `slidra effect move <presentation-id> slides/00N.svg <index> up|down` when the order needs fixing.
4. **Segment first, then add effects**: group the page's elements by "how many segments the speaker will talk it in" — title as one segment, then each bullet (or each comparison pair) as a segment; the title's underline, a card's number, and a number's caption belong to the segment they are in. **One `on-click` per segment**, no more than 5 per page. When a segment is already a group, apply one effect to the group id directly; when it isn't, use `--start with-previous` for the other elements in the segment. Run `slidra effect add` once per anchor, with the style-matched family/effect/duration:

   | Style | Title | Bullets | Image/table/chart | duration |
   |---|---|---|---|---|
   | Default (unspecified) | `enter/fade` | `enter/fade` | `enter/fade` | `0.4` |
   | Conservative | `enter/fade` | `enter/fade` | none | `0.3` |
   | Lively | `enter/zoom` | `enter/fly-up` | `enter/zoom` | `0.5` |

5. **Target is "the whole deck"**: repeat steps 2–4 per page; when the user also wants transitions, run `slidra slide transition set <presentation-id> <any page path> --enter fade --enter-duration 0.4 --all` once (`--all` applies to the whole deck).
6. **Seconds are always in seconds**: when the user says "300 milliseconds", convert to `0.3` before passing `--duration`/`--delay`.
7. **Verify**: read back with `effect list` to confirm the order.

## Wrap-up

After making changes, before replying, run `slidra validate <presentation-id>` once (only that page if only one page changed) and put the result on the first line of the report; if `errors` is not empty, fix and re-validate, ending this round only at 0 errors (see "wrap-up conditions" in `AGENTS.md`).

## Report format

Per page: page path, which effect each anchor got (family/effect/start/duration), and whether transitions were adjusted. When "filling in" or "redoing" existing effects, describe the before/after differences.
