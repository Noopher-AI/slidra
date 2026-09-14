Initial page count: 2 (`slides/001.svg` / `002.svg` are two undesigned template pages; directly `ls`-ing this un-executed fixture will show 2 pages — this is the expected initial state).

The flow is two stages: first `/slidra-plan [plan-from-outline] There are 2 pages so far; new pages will be appended at the end.` plus the content of `INPUT.md`. The agent writes `plan/` and stops. After the author approves in the confirmation dialog (or terminal), they send `/slidra-build [plan-confirmed] …`, and only then does the agent build.

## Plan stage must satisfy

- `cat <presentation-id> plan/outline.md` is readable: `status` is `draft`, `pages` covers only new pages with `n` starting at 3, every page has `relationship` and `rhythm`, no `type`, no `blueprint`.
- 4 sections each get one page plus a cover (and closing, if the agent judges the outline has a conclusion). Relationships must cover at least two types — "Core features" three items in parallel is `membership`, "Pricing plans" free/paid is `contrast`.
- `questions`: first asks narrative mode, last two are `animation` and `background`; every question has a `recommended`.
- `cat <presentation-id> plan/design-spec.md` is readable with seven palette roles, `type_scale`, `typography`, `shape_language`.
- No `slide`, `textbox`, or `element` commands executed: `ls <presentation-id> slides` still shows 2 pages.

## Build stage must satisfy

- `validate <presentation-id>` exits 0, `errors` is empty.
- Every page's `<slidra:notes>` is non-empty; content is colloquial sentences, not a re-copy of the page text.
- Text on pages uses the plan's keywords, not a verbatim copy of `INPUT.md`; must not contain numbers, company names, dates, prices, or promises not in `INPUT.md`.
- `plan/outline.md` has `blueprint` filled in for every page; adjacent two pages have different `shape`.
- `template list <presentation-id>` lists at least "Cover".
- `comment list <presentation-id>` still shows "0 comments total" — build fixes its own issues, no comments.

## Must appear in the conversation

- Plan stage: a table with `Page | Relationship | Rhythm | Claim`, and the sentence "The plan has been written to plan/".
- Build stage: per-page report (`Page N (slides/00N.svg): <shape>/<relationship>: <title> — added, <node count> units, <step count> steps`), and at least one question to the author — this `INPUT.md` has only 2–3 short bullets per section, which is "locally thin"; the agent should suggest "which pages to add content to" or "which pages to illustrate".

## Fail patterns

- Touched slides during the plan stage, or started building before the plan was confirmed.
- The plan wrote `type` or `blueprint` (that's build's job).
- `validate` has errors but reports completion.
- Expanded content with data, names, or promises not in `INPUT.md`.
- Every page uses the same `shape`.
- Never asked the author any questions throughout.
