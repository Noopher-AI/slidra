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
| 0002 | CLI is the only vocabulary | Partially superseded → 0014; later revised to "a single binary"; amended — `slidra` as sole reader (not only writer) is now OS-enforced on macOS via `denyRead` (ADR-0021), still discipline-based on Linux |
| 0003 | The `.slidra` container | Partially superseded → 0016; the `transition` field was retired and `formatVersion` moved 2→3, then 3→4. Superseded → 0020 for the container format and hidden-work-directory model (`formatVersion` 5, SQLite, no `work/<id>/`) — see `docs/spec/slidra-format.md` (the current on-disk authority) |
| 0004 | Presentation content is read-only to agents | Partially superseded → 0015; its second layer was overturned by 0019; amended — its third layer (no real-path leakage) gains an OS-enforced backstop on macOS (ADR-0021), and the working-directory path leak it had already conceded is closed |
| 0005 | Step-driven animation | Substantially revised → 0007, 0009 |
| 0006 | Connecting external agents via ACP | Partially superseded; amended — the agent now runs sandboxed (ADR-0021), the working directory moved off `<SLIDRA_HOME>/agent` to a per-serve scratch root, and conversations persist into the deck ([E6.T7]) |
| 0007 | Playing a `.slidra` requires the app | |
| 0008 | A slide is self-contained | |
| 0009 | Motion is an ordered list of effects | |
| 0010 | Slide content is untrusted | Partially superseded |
| 0011 | View mode runs a hit-reporting script | Partially superseded |
| 0012 | Every element is framed in a `<g transform>` | Extended with an exception (chart containers) |
| 0013 | Templates and locking replace masters | Amended — master view mode and the `slidra-apply-master` skill added; the no-inheritance/no-sync/no-link position is unchanged |
| 0014 | The style command uses SVG attribute names, gated by an allowlist | Extended with a section (table allowlist); revokes one clause of ADR-0002 |
| 0015 | Agents may import assets | Extended with a guardrail exception (`--as csv` data assets) |
| 0016 | Fonts are packaged with the `.slidra`; a standalone slide degrades to system fonts | |
| 0017 | In-place editing caret and selection: `textarea.selectionStart/End` is the single source of truth, with zero offset against SVG character indices | |
| 0018 | A new presentation starts empty; a plan is materialized as files inside the presentation, three roles hand off through a blocking gate, and validation is a CLI command | Amended — decision 9's file lock re-confirmed under SQLite; `plan/` outranks persisted chat history ([E6.T7]); `slidra-apply-master` added as a fourth independent skill |
| 0019 | The command gate now protects "presentation files must go through the CLI," everything else is allowed | Overturns the second layer of ADR-0004; Follow-up → 0021 (an OS-level sandbox, bounding writes only — the prompt-injection chain this ADR opened remains open) |
| 0020 | A deck is a database, not an archive | Supersedes ADR-0003 |
| 0021 | The agent runs in an OS sandbox, and so does the CLI | Follow-up to ADR-0019 |
| 0022 | One server, one current deck, switchable | |
| 0023 | A deck has an owner | Deliberately kept separate from ADR-0020; Extended with a section (`owner: null` is anonymous, never backfilled) |
| 0024 | An extracted module receives a named dependency object, never a shared internals bag | |
