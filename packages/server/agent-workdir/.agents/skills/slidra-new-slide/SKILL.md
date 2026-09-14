---
name: slidra-new-slide
description: Add a page at the end (or a specified position) covering something: when a plan exists, write one SVG page following build's six stages and append it to the plan; only when there is no plan use a template, duplicate a similar page, or write one from the layout library. Use when the author says "add a page about X" or the message starts with /slidra-new-slide
---

# Add a slide

## Steps

1. **Look at the existing pages first**: `slidra ls <presentation-id> slides` — know how many pages there are and what number the new page will be. Indexing starts at 1, filenames zero-padded to three digits (page 2 is `slides/002.svg`).
2. **Decide how to do it, in this order**:
   - **A plan exists** (`slidra cat <presentation-id> plan/design-spec.md` succeeds): build this page per `slidra-build` step 4's six stages (compose → background → foreground → group → animate → review); judge the relationship yourself per section 6.1 of `reference/slide-design.md` — if an adjacent page used the same `blueprint.shape` for the same relationship, pick a different one; when other pages have a background image (visible via `cat` on any page as `data-slidra-role="background"`), the new page reuses the same `assets/` path, not a new asset. When done, add this page to `pages` in `plan/outline.md` (`relationship` and `blueprint` are required; fill in `type` only when using a known solution; `status` stays unchanged).
   - **No plan but a template exists**: `slidra template list <presentation-id>`; when a template for the page type exists, `slidra slide add <presentation-id> --template <file path>`, then `text set` to overwrite the text.
   - **No plan, no template, but a structurally similar page exists**: `slidra slide duplicate <presentation-id> slides/00N.svg` to copy it, then `text set` to change the text.
   - **Nothing at all**: pick a solution from `slidra-layout-kit`, use `slidra-style-kit`'s `03 clean-brief` for colors, and write one page with `slide add --svg` per the syntax in section 0 of `slide-design.md` — run through that section's self-check list before submitting; a failing page is rejected whole.
   Pages hold keywords only (a bullet targets 1 line); full sentences go into `slidra slide notes set`.
3. **Acceptance**: `slidra validate <presentation-id> slides/00N.svg` until 0 errors (without a plan file it only checks geometry and skeleton; additionally `cat` and read back to confirm the text really landed). Tell the user the new page's path.

## Common pitfalls

- `slide add` without `--svg`/`--template` is a blank page with no text elements at all; a following `text set` will find no element id.
- If the whole deck has a background image, the new page needs one too; if the deck has none, don't add one to just this page — it will stand out jarringly in the thumbnail strip.
- When the user says "add three pages", finish and confirm one page before doing the next.
