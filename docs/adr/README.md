# Architecture Decision Records

An ADR records one decision that is hard to reverse, confusing without context, and the product of a real trade-off. **ADRs are never deleted or rewritten** — a superseded decision stays in place, because the record of what was judged at the time is itself valuable information.

## File naming convention

| Filename | Meaning |
| --- | --- |
| `NNNN-slug.md` | Fully in force |
| `NNNN-slug.amended.md` | **Some clauses no longer apply.** A banner at the top of the file lists what died, what replaced it, and what still stands |

An amended ADR always does two things: the filename gets `.amended` appended, and a banner goes under the title. Finer-grained amendments are additionally noted inline, right where the original text they touch appears.

Always cite an ADR by number (`ADR-0002`), never by filename — filenames change when a document is amended.

## Current list

| | Decision | Status |
| --- | --- | --- |
| 0001 | SVG is the artifact | Partially superseded → 0016 |
| 0002 | CLI is the only vocabulary | Partially superseded → 0014; later revised to "a single binary" |
| 0003 | The `.slidra` container | Partially superseded → 0016; the `transition` field was retired and `formatVersion` moved 2→3, then 3→4, with format details moved to `docs/spec/slidra-format.md` |
| 0004 | Presentation content is read-only to agents | Partially superseded → 0015; its second layer was overturned by 0019 |
| 0005 | Step-driven animation | Substantially revised → 0007, 0009 |
| 0006 | Connecting external agents via ACP | Partially superseded |
| 0007 | Playing a `.slidra` requires the app | |
| 0008 | A slide is self-contained | |
| 0009 | Motion is an ordered list of effects | |
| 0010 | Slide content is untrusted | Partially superseded |
| 0011 | View mode runs a hit-reporting script | Partially superseded |
| 0012 | Every element is framed in a `<g transform>` | Extended with an exception (chart containers) |
| 0013 | Templates and locking replace masters | |
| 0014 | The style command uses SVG attribute names, gated by an allowlist | Extended with a section (table allowlist); revokes one clause of ADR-0002 |
| 0015 | Agents may import assets | Extended with a guardrail exception (`--as csv` data assets) |
| 0016 | Fonts are packaged with the `.slidra`; a standalone slide degrades to system fonts | |
| 0017 | In-place editing caret and selection: `textarea.selectionStart/End` is the single source of truth, with zero offset against SVG character indices | |
| 0018 | A new presentation starts empty; a plan is materialized as files inside the presentation, three roles hand off through a blocking gate, and validation is a CLI command | |
| 0019 | The command gate now protects "presentation files must go through the CLI," everything else is allowed | Overturns the second layer of ADR-0004 |
