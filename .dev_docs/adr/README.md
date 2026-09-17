# Architecture Decision Records — Slidra

A record here captures **one** decision that is hard to reverse, is the product of a real
trade-off, and would confuse a newcomer without its context. All three, or it does not belong
here.

## What does not belong here

| | Where it goes |
| --- | --- |
| A fact that moves with the version — format, command set, field types, migration rules | `docs/spec/` |
| A target or a threshold | Product goals |
| Vocabulary | `CONTEXT.md` |
| Filenames, function names, test names, flag locations | Nowhere. The code is the record. |

Records may point at a spec file, and several do. That pointer is the mechanism: it is what
lets the volatile half change without anyone editing a decision record.

## Amendments

A record is never deleted or rewritten. When something changes, there are exactly two endings:

- **The decision was superseded.** Write a new record. The old one gets *one line* under its
  title: `Status: superseded by ADR-NNNN.` No comparison, no accumulated diff. The reason
  belongs in the record that replaced it.
- **It was never a decision matter.** Update the spec. The record is untouched.

There is no third ending. A banner longer than two lines means the wrong ending was chosen —
what is being written is a changelog, and changelogs belong in version control.

Cite a record by number, never by filename.

## Current list

| | Decision |
| --- | --- |
| 0001 | SVG is the slide artifact |
| 0002 | The CLI is the only vocabulary |
| 0003 | Deck content is read-only to agents |
| 0004 | Agents attach through a published protocol |
| 0005 | A slide is self-contained |
| 0006 | Motion is an ordered list of effects |
| 0007 | Slide content is untrusted |
| 0008 | Every element is framed in a transform group |
| 0009 | Templates replace masters, and a template dies on use |
| 0010 | Fonts are packaged; a standalone slide degrades |
| 0011 | A deck is a database, not an archive |
| 0012 | A deck has an owner |
| 0013 | An extracted module takes a named dependency object |
| 0014 | A workbench is one deck's session |
| 0015 | The deck server is the crate, and there is no way round it |
| 0016 | Every call names its caller |
| 0017 | Slidra spawns every agent it talks to |
| 0018 | Rendering is its own service |

## Map from the previous set

The set this replaces had 24 records. Numbers are not reused, so the mapping is recorded here
rather than preserved as gaps.

| Was | Now |
| --- | --- |
| 0001 | 0001 |
| 0002 | 0002 |
| 0004, and the later amendments to it (0015, 0019, 0021) | 0003, with the volatile half in the spec |
| 0006 | 0004 |
| 0008 | 0005 |
| 0009 — superseding 0005 | 0006 |
| 0010, absorbing 0011 | 0007 |
| 0012 | 0008 |
| 0013 | 0009 |
| 0016 | 0010 |
| 0020 — superseding 0003 | 0011 |
| 0023 | 0012 |
| 0007 | A consequence of 0011, not its own record |
| 0014 | 0002 — the styling exception is recorded there as a consequence |
| 0017, 0022 | `docs/spec/` — both record facts that move |
| 0024 | 0013 |
| 0018 | Split. Its surviving clause — a new deck starts empty — fails the hard-to-reverse gate: putting a starter slide back is an afternoon's work. Spec. |
