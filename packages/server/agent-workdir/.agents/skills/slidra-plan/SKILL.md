---
name: slidra-plan
description: Plan an outline or article into a page-by-page plan and design spec (narrative mode, relationships, rhythm, style, background), write them into plan/ and stop to wait for the author to approve in the confirmation dialog; do not touch any slides. Use when the author's message starts with /slidra-plan (the editor's New → From outline… and the confirmation dialog's "Re-plan" send this same form)
---

# Plan the whole presentation

You are the **strategist**: read the outline, pick the narrative mode, judge each page's relationship and rhythm, choose the style and background, pose the questions, write them into `plan/outline.md` and `plan/design-spec.md`, then **stop**. Making the pages is `slidra-build`'s job, and it only starts after the author confirms the plan.

## Input

After the slash command comes an outline or an article (bulleted sections, where indented lines are sub-points of the line above; or a full article, from which you extract the sections). It may start with an instruction line that is not part of the outline:

- "[plan-from-outline] This presentation has no slides yet." or "[plan-from-outline] There are N pages so far; new pages will be appended at the end." — a position instruction; when existing pages are present, the plan's `pages` covers only the new pages, and `n` starts at N+1.
- "[redo] <author's words>" — the author clicked "Re-plan" in the confirmation dialog, and the following text is what they want changed; rewrite the plan per it, keeping the rest from the previous version.

## Steps

1. **Check the current state**: `slidra cat <presentation-id> project.json` (canvas size, page count), `slidra plan list <presentation-id>`, `slidra template list <presentation-id>`.
   - A plan with `status` already `confirmed` exists, and the input is not [redo]: do not write yet; ask the author "There is already a confirmed plan — redo it or keep it?" and wait for the answer.
   - The input is completely empty, or just a casual remark: reply with one sentence asking which outline to use.
2. **Read the specs**: sections 6 and 7 of `reference/modes.md` and `reference/slide-design.md`.
3. **Pick the narrative mode**: look at the argumentative flow of the content sections (not the cover), pick one per `modes.md`, and note a one-sentence reason (it goes into the question's `note` later). When the author's outline is clearly topic-titled or explicitly names the mode, follow the author.
4. **Decide relationships and rhythm per section**: every page **must have a `relationship`** (section 6.1 of `slide-design.md`). **Judge the relationship first; do not think about layout first**; leave `type` blank — layout is what build picks based on the relationship; writing `type` at the planning stage makes build use that page type directly, degrading the whole deck into one repeated layout.
   Rhythm: cover, section, and closing are `anchor`; a single-number page is `breathing`; everything else is `dense`. Split more than 6 bullets into two pages; no conclusion means no closing page; don't fabricate pages for page count or rhythm.
   **Variety is a hard requirement**: with 4+ pages, the same relationship must not exceed half the total page count (`roster.relationship-variety`); when two adjacent pages share a relationship, first consider whether those two sections should be merged, or whether one is actually a different relationship. When the author's content genuinely has no variety, say so plainly in the report. When the author gives only one sentence and you must generate the content, deliberately place adjacent pages on different relationships, cover at least three kinds across the deck, and land on one conclusion.
   Done when: every page has a `relationship` and a `rhythm`, and the relationship distribution passes the two rules above.
5. **Write the page-by-page plan**: for each page list the claim (one sentence; target within 15 characters, limit 24, it becomes the title), audience change (what is different before/after hearing this page — a page you can't write this for should be merged or cut), page keywords (target within 18 characters, limit 32; these are the words that actually appear on the page), and the 2–3 sentences the notes should say. Claims, keywords, and notes may only come from the author's outline; missing material gets a `free_text` question in step 6 — don't invent data, names, or dates for the author.
6. **Pose the questions**: 3–7 questions. The first always asks the narrative mode; the last two always ask animation (`id` is `animation`, `recommended` is `full`, options `full` = full, `minimal` = title and bullets only, `none` = none) and background image (`id` is `background`, `recommended` is `on`, options `on`/`off`; the `note` names the recipe picked in step 8); each question in between corresponds to one judgment you are unsure about. Every question needs a `recommended` (must be one of the `options`), 2–4 `options`, and a one-sentence `note` with your view; questions that need the author to supply material get `free_text`.
7. **Write `plan/outline.md`**: `slidra plan set <presentation-id> outline '<full text>'`. Full text = one leading ```` ```json ```` fence (fields below) + one `## Page N: <claim>` section per page after it, with four lines under each: claim, audience change, page keywords (one per line), notes. `status` is always `draft`. The body must not contain half-width single quotes.
8. **Fit the style and background**: follow `slidra-style-kit`'s steps to pick one style (including shape language, font imports, canvas `k`) and write it into `plan/design-spec.md`; then pick one recipe per the style file's "suggested background" and the `slidra-background-kit` index, and write its number, name, and a one-sentence use into the background question's `note`. When a style file suggests `off`, give the background question `recommended` `off`. When the author wants a social post, a portrait or square single sheet, first clarify the canvas and explain in the report that `presentation canvas set` will be used.
9. **Stop**: don't issue any `slide`, `textbox`, or `element` commands. When reporting, say "The plan is written; the editor will pop up the confirmation dialog; pressing Confirm and build starts the work". In environments without a dialog (the author talks directly in the terminal), paste the plan table in the conversation and ask the author to reply with `/slidra-build [plan-confirmed]` plus each answer.

## The JSON section of `plan/outline.md`

```json
{
  "status": "draft",
  "mode": "pyramid",
  "animation": "full",
  "background": "on",
  "pages": [
    { "n": 1, "relationship": "none", "rhythm": "anchor", "title": "This page's claim, in one sentence" },
    { "n": 2, "relationship": "membership", "rhythm": "dense", "title": "This page's claim, in one sentence" }
  ],
  "questions": [
    {
      "id": "mode",
      "question": "The narrative skeleton of this presentation",
      "note": "Why you recommend this mode, in one sentence.",
      "recommended": "pyramid",
      "options": [ { "value": "pyramid", "label": "Conclusion first" }, { "value": "narrative", "label": "Story line" }, { "value": "briefing", "label": "Neutral briefing" } ],
      "free_text": false
    },
    {
      "id": "animation",
      "question": "Animation intensity",
      "note": "Why you recommend this animation intensity, in one sentence.",
      "recommended": "full",
      "options": [ { "value": "full", "label": "Full" }, { "value": "minimal", "label": "Title and bullets only" }, { "value": "none", "label": "None" } ],
      "free_text": false
    },
    {
      "id": "background",
      "question": "Background image",
      "note": "The number, name, and one-sentence use of the background recipe you picked; none means a plain color background.",
      "recommended": "on",
      "options": [ { "value": "on", "label": "With background image" }, { "value": "off", "label": "None" } ],
      "free_text": false
    }
  ]
}
```

`animation` may only be `full`, `minimal`, or `none` (omitted means `full`); `background` may only be `on` or `off` (omitted means `on`); `rhythm` may only be `anchor`, `dense`, or `breathing`; `n` increments consecutively from 1 (or existing page count + 1); `questions[].id` uses alphanumerics and `-`, unique within the file.

Each page also has optional `type` and `blueprint`; both are written by `slidra-build` during the composition stage, left blank at the planning stage; when re-planning, keep an existing blueprint unless that page's content really changed.

## The JSON section of `plan/design-spec.md`

```json
{
  "density": "presentation",
  "palette": { "background": "#RRGGBB", "secondary_bg": "#RRGGBB", "primary": "#RRGGBB", "accent": "#RRGGBB", "secondary_accent": "#RRGGBB", "text": "#RRGGBB", "muted": "#RRGGBB" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "plain",
  "visual": "the visual value from the style file"
}
```

`layout` is the deck-wide layout anchor: the safe-area's three boundaries, the column gutter, and the allowed spacing steps. Each page's coordinates may differ, but these numbers stay consistent deck-wide — `validate` uses the three boundaries to check overflow. The whole object may be omitted (omitting means the defaults above); if written, it must be legal numbers. When the canvas is not 1280×720, these values scale by `k` just like font sizes.

## Report format

First line: the mode and reason, the style name with a one-sentence feel, the animation intensity, the suggested background recipe, and the total page count. Then a table, one row per page: `page | relationship | rhythm | claim`. The final line is fixed: "The plan is written into plan/; please approve it in the confirmation dialog; to change a page, click Re-plan and tell me what to change." The JSON goes only into the file; what the author sees in the conversation is the table.
