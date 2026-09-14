---
name: slidra-build
description: Build slides page by page from the author's confirmed plan/ outline and design spec: write one SVG per page, group elements, apply animations, register templates, pass the first-page gate, and run slidra validate until 0 errors before reporting. Use when the author's message starts with /slidra-build (the [plan-confirmed] sent from the confirmation dialog, a direct build request in the terminal, or "redo page N")
---

# Build slides from the plan

You are the **executor**. The plan (`plan/outline.md`) and design spec (`plan/design-spec.md`) have already been written by `slidra-plan` and approved by the author in the confirmation dialog; your job is to **write each page as one SVG**, group elements, apply animations, and get `slidra validate` down to 0 errors. **Do not start unless the plan is confirmed.**

## Input

The message sent by the confirmation dialog looks like this:

```
/slidra-build [plan-confirmed]
<question id>=<option value>
<question id>.note=<free text written by the author>
Supplement: <overall feedback>
```

- Bare `/slidra-build`: the author is asking you to build directly in the terminal; the plan must already be `confirmed`.
- Followed by a page number or page range: redo only those pages (whole-page overwrite with `slide set --svg`); the plan must still be `confirmed`.

## Steps

1. **Read the plan**: `slidra cat <presentation-id> plan/outline.md`. If the file is missing → stop and say "There is no plan yet, please run /slidra-plan first".
2. **Handle the confirmation**:
   - Message contains `[plan-confirmed]`: apply each answer to the plan's JSON section (`mode`/`animation`/`background` questions update the corresponding fields; `page-N` questions update that page; the `palette` question updates the `palette` in `design-spec.md`; `.note` and "Supplement" content goes into that page's keywords or speaker notes), clear `questions`, set `status` to `confirmed`, and write it back with `slidra plan set <presentation-id> outline '<full text>'` (if the palette changed, also `plan set design-spec`).
   - No `[plan-confirmed]` and `status` is not `confirmed`: stop and reply "The plan is not confirmed yet, please approve it in the confirmation dialog first".
   - Has `[plan-confirmed]`, but the plan is already `confirmed` and `slidra ls <presentation-id> slides` already has slides: the same confirmation was sent twice. Reply "This plan has already been built (currently N pages). To redo, say 'redo page X' or 'redo all'", then stop — forcing a rebuild would overwrite the pages the author has on hand.
3. **Read the spec and current state**: `slidra cat <presentation-id> plan/design-spec.md` (palette, density, type scale table, `layout`, `shape_language`), `slidra cat <presentation-id> project.json` (canvas, `k = width ÷ 1280`), `slidra template list <presentation-id>`, `slidra ls <presentation-id> slides`. Read sections 0–5 of `reference/slide-design.md`, and the "how to achieve it" part of `.agents/skills/slidra-style-kit/shapes/<shape_language>.md` — every page in the deck follows that one shape language.
   When the plan's `background` is `on`, **build the background asset first**: the recipe is the one in the plan's background question `note` (the `slidra-background-kit` catalog); follow its steps with `asset import --svg`, build one recipe only once, and note the returned `data.path`.
4. **How to make one page** (six stages, in order; do not skip to the next stage until the previous one is done)
   1. **Compose**: the plan gives this page's `relationship`; the layout is your decision. First read section 6.1's "what the geometry must carry" for that relationship; then `cat plan/outline.md` to see page N−1's `blueprint.shape` — **when the relationship is the same, this page must use a different shape**; then follow the `slidra-layout-kit` index to pick one from that relationship's group, and read only the one reference file you chose. Decide the number of semantic units (`nodes`) and speaking steps (`steps`); if you can't figure out "how many segments to speak this page in", the content is not yet clear — go back and reread the plan. Write the conclusion back into this page's object in `plan/outline.md` (`status` stays `confirmed`):

      ```json
      { "n": 3, "relationship": "order", "rhythm": "dense", "title": "…",
        "blueprint": { "shape": "spine-path", "nodes": 4, "steps": 4 } }
      ```

      Write `"type"` only when the chosen shape happens to be one of the known solutions in section 6.3; composed layouts do not get a `type`. **Every page's `blueprint` is required** (`blueprint.required`).
   2. **Background**: when `background` is `on`, use the asset built in step 3; when `off`, skip.
   3. **Foreground**: lay out according to the slot table in the layout reference file — coordinates and proportions are derived from this page's content and `design-spec.layout`; the numbers in the wireframe are illustrative. Font sizes and colors come from the type scale table and palette; spacing comes from `layout.gutter` and `layout.spacing`. Mark `data-slidra-role` on every element (section 3b), write all text as text-box declarations (section 0), replace `<role>` with color codes, and replace sample text with the plan's keywords (title = claim). When `background` is `on`, write the scrim rect in as well (section 4b). For the first page: `slidra slide add <presentation-id> --svg '<SVG>'`; when appending after existing pages, add `--at <n-1>`; to redo a page: `slidra slide set <presentation-id> slides/00N.svg --svg '<SVG>'`. **Before submitting, run through the self-check list in section 0** (especially how many lines each text box wraps to, and whether the next element's `y` is being squashed) — a failing page is rejected whole, and the response lists which rules failed; fix and resubmit. Then:
      - `slidra slide style set <presentation-id> slides/00N.svg --background <role color>`: most pages use `background`; closing pages use `primary`. Within one deck, changes in the base color are themselves a signal; only change it deliberately.
      - When `background` is `on`: `slidra slide background set <presentation-id> slides/00N.svg --asset <data.path> --opacity <recipe-suggested value>`; when redoing a page that already has a background but the plan is `off`, remove it with `--none`.
   4. **Group**: group the elements in the same segment (usually one `node` together with its `field`, `label`, `garnish`) with `slidra element group <presentation-id> slides/00N.svg <element ids, comma-separated>`, and note the returned `data.elementId`. When the title stands alone as a segment, no group is needed; the background image and the three footer pieces do not go into any group.
   5. **Animate**: per section 5, apply `slidra effect add` to the group ids — one `on-click` per segment, no more than 5 per page; when `animation` is `none`, skip this stage entirely.
   6. **Review**: `slidra validate <presentation-id> slides/00N.svg` must have 0 errors. When `blueprint.nodes`/`blueprint.steps` don't match, fix the page (add or remove a node, add or remove an `on-click`) — once a page is drawn, that page's `blueprint` is read-only and `plan set` will block it; only when the composition was genuinely planned wrong (e.g. the whole page changed layout) add `--force` to change it, and tell the author in the final report what you changed and why. Then wrap up:
      - `slidra slide notes set <presentation-id> slides/00N.svg '<speaker notes from the plan, 2–5 colloquial sentences>'`.
      - First occurrence of a page type (a page with a `type`): `slidra template add <presentation-id> --from slides/00N.svg --name <template name>` (names in section 6.3). Subsequent pages of the same type are still rewritten page by page through the six stages; the template is for the author to use in the New panel.

   **When you discover mid-way that the content needs a different layout** (a video, image, or data set just appeared, or the content is actually a cycle, funnel, or pyramid): go back to the layout library and re-pick by "find a layout by material", and update `blueprint.shape`, `nodes`, `steps` in sync (already-drawn pages need `--force`; explain in the report). When the material doesn't exist yet, use a layout that doesn't need it first, and swap it in with `slide set --svg` once the material arrives.

5. **First-page gate**: build the cover and the first content page first, and `validate` each. If there are errors, fix the approach first (shorten keywords that are too long, revert font sizes or colors to the values in the tables, add missing animations), and only once both pages are at 0 errors move on to page 3 onward.
6. **Build page by page**: in the order of `pages`, finish one page and **immediately** do the next — **do not end the turn between pages**. The whole build is one thing to finish in one round, not one page per round; if you stop halfway to report progress, the deck sits there waiting for the author to come back and type "continue" (`AGENTS.md` "how far does one round go"). Pages hold only the "page keywords" from the plan; full sentences go into the speaker notes; the limits in section 7 are floors, not targets. Numbers on big-number pages, and any names and dates, may only come from the plan.
7. **Transitions for the whole deck**: when `animation` is not `none`, as soon as page 1 is done, apply `slidra slide transition set <presentation-id> slides/001.svg --enter fade --enter-duration 0.3 --all` once (otherwise the first-page gate will definitely report `motion.transition`), and apply it once more after all pages are done so that later-added pages also get transitions.
8. **Validate the whole deck, fix to 0 errors**: `slidra validate <presentation-id>`; handle each error per the "how to fix" column in section 9's table. When `text.*` counts exceed the limit and a page must be split, use `plan set outline` to add a page to the plan — appending at the end is unrestricted, but inserting in the middle shifts every later page back and requires `--force`. After fixing, run it again until `errors` is empty. **Do not report completion while errors remain**, and do not send "N errors still to fix" as the report — fixing to 0 errors is still part of the same round.
9. **Report**: in the format below.

## Protected plan fields

After the plan is confirmed, `plan set` always blocks changes to `mode`/`animation`/`background`, existing pages' `relationship`/`rhythm`/`title`, and page deletion — these are the questions the author answered at the gate; to change them, go back and ask the author. The only things you may change yourself: writing a page's `blueprint` for the first time, pages not yet drawn, `type`, and appending pages at the end.

## Report format

First line: "Built per plan, validate 0 errors, animation <full/minimal/none>, background image <on/off>".
If you were truly blocked and had to stop at page N (only the 2nd and 3rd situations listed in `AGENTS.md` count), make the first line `Incomplete: built N/M pages, stuck at <where>`, then state what decision the author needs to make — do not end an unfinished task with a completion sentence.

One line per page: `Page N (slides/00N.svg): <shape>/<relationship>: <title> — added / overwritten, <node count> units, <on-click step count> steps`. Finally list the questions for the author, one per line: which pages you recommend illustrating, which pages have thin content, and what you changed with `--force` on which pages. Fix validation failures yourself; do not leave comments.
