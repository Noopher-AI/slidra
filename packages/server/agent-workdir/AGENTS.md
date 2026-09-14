# Slidra Agent Handbook

This document is deployed into your (the agent's) work directory as stable, long-term guidance; the editorial brief you get at the start of every conversation only covers what changes (the ID, quoting rules) — everything else lives here and in `reference/`, and you can come back and read it anytime with your native file-reading ability.

Every time `slidra serve` starts, this work directory is redeployed wholesale from the package's built-in version; any change you make here is never kept — keep your notes in the conversation instead.

## What Slidra is

Slidra is a presentation-editing tool. The author operates the presentation through the graphical editor in a browser; you (the agent) operate the same presentation through `slidra` commands — both sides change the same file, not separate copies. Every slide in a presentation is a valid SVG, and the SVG itself is the finished artifact; there is no more authoritative representation behind it.

## Environment and constraints

The editorial brief already said this: the presentation's content can only be read or written through `slidra` commands, and every other shell command is unrestricted. Here are three things it did not say:

- "Only through commands" refers to the presentation's physical files: using shell file tools (`sed`, `cp`, `rm`, etc.) against them will be blocked, and you never get those paths in the first place anyway. Commands unrelated to the presentation (looking things up, handling temp files, running other tools) — do them however you normally would.
- When blocked, the message you get back reads like "the user declined this tool use", which looks like the author clicked reject — they did not. Slidra will separately tell you which command to use instead; just switch to it, no need to ask the author why it was refused.
- Remember to quote color codes (`'#3366FF'`), or the shell will treat everything after `#` as a comment and swallow it.

## Command reference

`slidra`'s full command list — every command's name, parameters, and a one-line purpose — is in [`reference/commands.md`](reference/commands.md). Check that reference before you act; don't guess other commands' syntax from the two examples in the editorial brief.

Layout, font size, color roles, animation, and validation rules always follow [`reference/slide-design.md`](reference/slide-design.md); narrative modes and pacing follow [`reference/modes.md`](reference/modes.md); importable open-source fonts follow [`reference/fonts.md`](reference/fonts.md). Leave validating the design rules to the `slidra validate` command — don't work it out in your head.

## Virtual file structure

A presentation is this set of virtual paths, which you can only read and write through `slidra` commands (you never get, and never need, the real file locations):

- `project.json`: the presentation's metadata (name, canvas size, slide list, embedded fonts).
- `slides/00N.svg`: each slide page, indexed from 1, zero-padded to three digits in the filename (page 2 is `slides/002.svg`). Whole-page writes use `slide add --svg` / `slide set --svg`; see `reference/slide-design.md` section 0 for the rules.
- `assets/`: imported media — images, video, audio. You cannot write files directly, but `asset import --svg` can create an SVG asset straight from command-line content (this is how background images get made).
- `fonts/`: font files embedded in the presentation.
- `templates/00N.svg`: reusable templates saved by `template add`; always use the `file` field `template list` returns for a template's path — the name and the filename are not the same thing.
- `plan/outline.md`, `plan/design-spec.md`: this presentation's page-by-page plan and design spec, always exactly these two filenames. The file opens with a ```` ```json ```` fence (machine-readable), followed by markdown prose. Only `plan set` writes it, `cat` reads it, `plan delete` removes it; both `validate` and the confirmation dialog read it.

## Key SVG conventions

- Every editable element is wrapped in a `<g id="el-…" data-slidra-name="…">` container; a bare element is refused by most commands, which require running `convert` first.
- Always read element ids out of `slidra`'s own return value or a `cat` result — `cat` the page before acting on it.
- A whole-page write (`slide add --svg` / `slide set --svg`) **has a gate**: if this page's own geometry, text volume, font-size/color, role consistency, asset paths, or scrim don't pass, the whole page is refused — nothing is written at all. A refusal is not the author clicking reject; the response lists every rule that failed. Run through `reference/slide-design.md` section 0's self-check list before submitting — **you must estimate a text box's line count yourself**; a title that wraps to two lines without pushing the next element down is the most common failure.
- Referenced assets (an image's `href`, media's `data-slidra-media`) are written as `../assets/…` inside the page SVG — a slide lives under `slides/`, and the path is relative to it. `asset import`'s returned `assets/…` is a virtual path and is auto-completed to `../assets/…` on a whole-page write, but pointing at a file that doesn't exist still just renders a blank spot, caught by `validate`'s `asset.missing`.
- Speaker notes live in `<metadata><slidra:notes>`, readable only with `cat`.
- Comments live in `<metadata><slidra:comments>`; `comment list` reads, `comment add` writes, `comment delete` removes.
- Animation effects live in `<metadata><slidra:effects>`; their order is the playback order. `effect list` exits non-zero when this slide has no effects at all — that means "no animation", not an error.

## Working conventions

- Before changing any page, first `slidra cat <presentation-id> slides/00N.svg` to read its current content.
- Every command you run within this one reply is folded into a single group the author can undo in one press — so finish one request within the same turn; `undo`/`redo` act on the same history you share with the author, not a scratchpad for trial and error.
- Delete a comment with `comment delete` once it's handled; leave one you can't act on as-is, and ask about it in the conversation.
- Do one page at a time, confirm it, then move to the next; when the author asks for multiple pages at once, this is what lets an error mid-way tell you exactly where you stopped. **This is the pacing for issuing commands, not a reason to end the turn** — finish one page and move straight to the next, don't stop to report progress.
- `slidra` commands against the same presentation are queued by the CLI itself; issuing several in parallel is safe but no faster — issue one at a time, read its result, then issue the next, so a failure tells you exactly which one.

## What counts as finishing a turn

The author sends one message, you reply once — everything in between is one turn. **A turn must finish the whole thing the author's message asked for**, not stop at some milestone to report progress.

It is normal for the author to step away right after hitting send; if you reply with something like "finished the first two pages, the rest to follow", the presentation just sits there until they come back and type "continue". To them, that isn't progress — it's a stall.

**Only these three situations may end the turn:**

1. The work is done, and the finishing conditions (next section) pass.
2. The author needs to decide something you have no authority to decide for them (the plan hasn't been approved yet, a page they're holding would be overwritten, text contains a literal single quote the command line can't express).
3. The same obstacle blocks you and a different approach still doesn't get past it (the same command rewritten twice still fails, missing material you cannot produce).

**Situations that do NOT end the turn** (keep going in all of these, don't stop):

- There is still a page not built, a comment not handled, or an error not fixed — no matter how many pages you've built, how many commands you've run, or how long it's taken.
- You feel like "this is a good milestone, let the author take a look". The author wants it done, not a mid-way preview.
- You feel the turn is getting too long. Length is not a reason to stop.

**If you genuinely fall into situation 2 or 3 and must stop**: the first line of your reply must be `Incomplete: <what's still missing>`, followed by a line saying where you're stuck and what decision you need from the author. Never close out unfinished work with a completion phrasing ("Done…", "Currently built…") — the author will think it's finished.

## Finishing conditions

**Whenever this turn touched any page's content, the very last thing before replying must be `slidra validate <presentation-id>`** (validating just that page is fine when only one page was touched), and the result goes in the first line of your reply: `validate: 0 errors` or `validate: N errors remaining`.

Without running validate, you cannot know whether something broke — "looks fine" doesn't count: whether text wraps, whether a wrap pushes into the next element, whether an image's asset exists, whether font size and color have drifted from spec — these are things you cannot see while issuing commands, and only validate can.

If `errors` is not empty, keep fixing and re-validate until it reaches 0 — **this is still the same turn**, don't send "there are still errors to fix" as your reported outcome. If you genuinely cannot fix one (situation 3 from the previous section), use that section's format to say which one, and what you tried.

## Skills

Every skill's full steps are in your work directory's `.agents/skills/<name>/SKILL.md` (Claude Code reads the same content from `.claude/skills/<name>/SKILL.md`). The directory name, the `SKILL.md`'s `name`, and the slash command the author types are all identical. **Whenever the author's message starts with `/slidra-<name>`, that means they want you to follow that skill**: read that `SKILL.md` first, then follow the steps inside it — the text after the slash command is that skill's input.

The three asset libraries (`style-kit`, `background-kit`, `layout-kit`) are part of `plan` and `build`'s normal flow: the planning stage adapts a color scheme and background recipe from the style library; the build stage picks a layout per page from the layout library. All three libraries are "a starting point, not a whitelist" — you can adapt, mix, or generate your own.

| Author types | skill | When to use |
|---|---|---|
| `/slidra-plan` | `slidra-plan` | Turn an outline into a page-by-page plan and design spec, write it into `plan/`, then wait for the author to approve it in the confirmation dialog |
| `/slidra-build` | `slidra-build` | Following the approved plan, write one SVG per page, apply animation, register templates, and fix with `validate` down to 0 errors |
| `/slidra-new-slide` | `slidra-new-slide` | Add a page about something |
| `/slidra-validate` | `slidra-validate` | Run `slidra validate` and proofread typos and animation order, pin every issue as a comment — comment only, never edit directly |
| `/slidra-reshape` | `slidra-reshape` | Work through pinned comments one by one, deleting each after it's handled |
| `/slidra-animate` | `slidra-animate` | Add sequential-reveal animation and transitions to a given page or the whole deck |
| `/slidra-style` | `slidra-style` | Unify font sizes, colors, and fonts across the deck, or apply one page's style to all |
| `/slidra-notes` | `slidra-notes` | Add conversational speaker notes based on each page's content, with an optional target duration |
| `/slidra-table` | `slidra-table` | Turn a pasted Markdown table into a table on a given page |
| `/slidra-chart` | `slidra-chart` | Build a chart from a data series on a given page, with optional dual axes and stacking |
| `/slidra-style-kit` | `slidra-style-kit` | Pick one from the style library and write it into `plan/design-spec.md` |
| `/slidra-background-kit` | `slidra-background-kit` | Pick a recipe from the background library, build it into an asset, and apply it to the page |
| `/slidra-layout-kit` | `slidra-layout-kit` | Pick one from the layout library to lay out a given page |
| `/slidra-apply-master` | `slidra-apply-master` | Sweep a template's just-saved change onto every existing slide made from it |
