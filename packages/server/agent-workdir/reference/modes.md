# Narrative Modes and Rhythm

A presentation uses **exactly one mode**. Write it into the `mode` field of `plan/outline.md` before writing `plan/design-spec.md`. A mode decides the skeleton — how titles are written, the density tendency, how one page advances to the next — not the visual style; color and type scale are chosen separately in `slide-design.md`. Pick based on **the argumentative flow of the content pages**, not the cover and not the first word of the outline.

## Five Modes

| Mode | One-line definition | How to write titles | Density tendency | Pick it when the outline looks like this |
|---|---|---|---|---|
| `pyramid` | Conclusion first, then structured support; open with "situation → conflict → question → answer" | **The title is the conclusion** ("This quarter revenue grew 23%, above the global average"), not a topic label | Medium: one claim per page plus concise evidence | The author must make a decision or accept a recommendation; there are trade-offs and criteria; boards, investors, analysis, strategy |
| `narrative` | Story line: situation → tension → turn → resolution, carrying people and emotion | Titles are story beats ("Then the numbers didn't add up") | Dense pages and breathing pages alternate, following the tension | Pitches, case studies, brand histories, fundraising — the point must land emotionally first |
| `instructional` | Break down then order: simple to complex, prerequisites before dependencies; one page teaches one step | Titles say what this page teaches ("First, distinguish template from master") | Medium-high: same-level concepts use the same structure and depth | Teaching, walkthroughs, explanations, onboarding — understanding must be built step by step |
| `showcase` | Images or numbers lead, text recedes; enlarge one idea at a time | Short, visual phrases ("12 minutes") | Low: lots of whitespace; the talk is in the speaker notes | Launches, brand reveals, event openings; the speaker on stage leads |
| `briefing` | Neutral, complete, referenceable; topic titles, same-level equal weight, predictable order | **Topic-style titles** ("Q3 headcount by department") | Medium: completeness over curation | Progress reports, reference material, tables of contents, meeting materials, FAQs — no argument needs to outrank the others |

**Easily confused pairs**:
- pyramid vs briefing: landing a recommendation → pyramid; complete information → briefing.
- narrative vs pyramid: the argument is carried by a story arc → narrative; conclusion stated up front → pyramid.
- narrative vs showcase: the argument advances through story → narrative; through imagery and presence → showcase.
- instructional vs briefing: building understanding → instructional; just laying out reference material → briefing.

When the author's outline already uses topic-style titles, or the author explicitly names the mode, follow the author; the mode only influences your title-writing and density tendencies, not the order the author gave.

## Three Rhythms

Every page gets one rhythm in `pages[].rhythm` of `plan/outline.md`:

| Rhythm | What it is | Rules |
|---|---|---|
| `anchor` | Structural pages: cover, section dividers, closing | **Page 1 must be an anchor**; the cover needs a concrete hook (the outline's strongest claim, number, or conflict), not a vague title; a closing needs a line worth taking away — don't make a closing page for an outline with no conclusion |
| `dense` | Information pages: key-point pages, comparison pages | This is the baseline rhythm; one idea per page |
| `breathing` | Low-density impact pages: big-number pages, one-claim pages, section transitions | **Card grids are forbidden** (full-page color-block `rect`s no more than 2); rely on whitespace and big type, not boxes |

- Rhythm also determines the animation weight (section 5 of `slide-design.md`): anchor pages enter their geometry first, then the title; dense pages get one card per step; breathing pages use zoom for the single protagonist and fade for everything else. The `animation` field in `plan/outline.md` only adjusts intensity (full/minimal/none), not this principle.
- The start of a section must visibly reset: a section page or a breathing page.
- Several consecutive pages on the same rhythm are fine, but deliberately; **don't fabricate pages for rhythm's sake** — a breathing page must stand on its own, not be filler.
- Each section's arc: frame first, then explanation or evidence, then judgment or action; the deck's final section must resolve the goal before the real ending.
