---
name: slidra-style
description: Unify the type scale, colors, weights and fonts of the whole deck, apply one page's style to all, or change a page's base color. Use when the user says "unify font sizes", "change body color", "make all titles the same size", "apply this page's style to all", "change the page background color", or the message starts with /slidra-style
---

# Unify styles

Style changes cover color, size, font, weight, and the page base color; line height is not in the style whitelist (see step 7).

## Input

- Target roles: title/body/all text, or a specific page's style as the template.
- Target attribute and value: size (number), color (`#RRGGBB`), font, weight, or the page base color/accent color.
- When the target or a value is missing, first run `slidra ls <presentation-id> slides` to see the current state, ask the user for the missing item, and issue no write commands until it's clear.

## Steps

1. **Unify title/body size or color deck-wide**: `slidra cat <presentation-id> slides/00N.svg` per page, find the elements of the matching role by `data-slidra-name` (the title class, or the page's largest-`font-size` text element counts as the title; the remaining text elements count as body), then `slidra element style set <presentation-id> slides/00N.svg <el-ids comma-separated> <attr> <value>`. Color codes get a `#` and are single-quoted: `fill '#F4F6F8'`.
2. **Apply page N's style to all**: first `cat` page N, read the actual `font-size`/`fill`/`font-family`/`font-weight` of its title and body, list the read values for the user to confirm, then apply page by page to the matching-role elements on the other pages.
3. **Fonts**: only families already embedded in the deck (`fonts` in `slidra cat <presentation-id> project.json`) can be written; for anything missing, follow `reference/fonts.md` and `font import` first.
4. **Page base color and element fill are two different things**: `slidra slide style set <presentation-id> slides/00N.svg --background '#RRGGBB'` changes the root `<svg>`'s style; when that page also has a full-page background `<rect>` element, `--background` is hidden behind it and the effect isn't visible — to change the visual base color you must change that `<rect>`'s `fill` (via `element style set`). Ask the user which one they mean first.
5. **The target is a table or chart element**: the command replies "use the table/chart command families to adjust"; relay the original error to the user and suggest switching to `/slidra-table` or `/slidra-chart`.
6. **Change part of a passage's weight/font**: only text boxes (elements with a `data-slidra-text-width` attribute) can use `slidra text style set <presentation-id> slides/00N.svg <el> --range <start:end> <attr> <value>`. A bare `<text>` element replies "element is not a text box"; use `element style set <id> font-weight 700` instead (the whole element changes together) and explain the difference to the user.
7. **The user asks for line or paragraph spacing**: answer clearly that it's not currently supported (the whitelist has no `line-height`) and stop there; changing the `y` coordinate, scaling, or adding blank lines are not line height.
8. **Verify**: `cat` and read back to confirm the attribute actually changed.

## Wrap-up

After making changes, before replying, run `slidra validate <presentation-id>` once (only that page if only one page changed) and put the result on the first line of the report; if `errors` is not empty, fix and re-validate, ending this round only at 0 errors (see "wrap-up conditions" in `AGENTS.md`).

## Report format

List the changed element ids, attribute, new value, and the pages the change applies to. If "apply page N's style" is involved, list the original values that were read.
