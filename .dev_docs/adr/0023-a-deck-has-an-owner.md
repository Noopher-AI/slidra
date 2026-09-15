# A deck has an owner

No real sign-in exists in this product yet — there is no login screen, no session, no account. This ADR decides to build the *shape* of ownership now anyway, ahead of the identity system that will actually populate it, rather than waiting until sign-in exists to decide what a deck's relationship to a person even is.

## Decision: decks carry an owner field, defaulting to "Anonymous"

`project.json` gains an optional `owner` field — an ordinary, free-form string, part of the virtual tree like `name` or `canvas` (see ADR-0020's virtual-files/side-data split: owner is **not** side data, it is a `project.json` field). `deck meta set --owner <name>` (`commands::deck`) writes it directly; `deck ls --owner <name>` filters the deck-folder listing by it (`packages/server/src/storage/deck-store.ts`). Every deck created through `DeckStore.create`/`import` resolves an owner explicitly at creation time, defaulting to the literal string `"Anonymous"` (`DEFAULT_OWNER`) rather than leaving the field absent — a deck predating this field is the only case where it is legitimately missing, read back as `null`, never as `"Anonymous"` retroactively assigned. This mirrors ADR-0003's own forward-compatibility convention: an old file without the field stays structurally valid, exactly as an old file without `fonts` did under ADR-0016.

## Why identity is built now, while no real sign-in exists

Ownership needs to be attributable from the first deck a person ever creates — retrofitting an `owner` field onto decks that already exist, once sign-in ships, means either an irreversible one-time migration guessing at authorship or a permanent class of "ownerless" legacy decks. Defaulting new decks to `"Anonymous"` now, and defining sign-in as *claiming* an anonymous deck rather than *creating* an owned one, means the migration problem never has to be solved later: every deck, from the very first one, already has an owner field with a well-defined value.

## The identity provider interface: shaped for an asynchronous flow, not a local one

**This is a decided interface shape, not a shipped feature** — no identity provider is implemented as of this ADR; the login flow itself is [E6.T9]'s scope (NOOP-427), and any account/session/multi-tenant behavior beyond a single local machine belongs to the cloud edition, not this one.

The shape decided here: an identity provider is an **asynchronous, out-of-band** flow — modeled on Email Magic Link (request a link, the confirmation arrives and is completed out-of-band, possibly on a different device or tab, possibly minutes later) — rather than a synchronous local flow (a password prompt the same process blocks on and resolves immediately). This is deliberate even though the first product surface is a single local machine with no network-dependent account system yet: a synchronous interface designed for "the answer comes back on this same call" would have to be reshaped, not merely extended, the moment a real out-of-band provider (email, OAuth redirect, a device-pairing code) is wired in — the pending/confirmed state such a flow requires doesn't retrofit cleanly onto a call-and-block shape. Deciding the asynchronous shape now, before any concrete provider exists to test it against, is a bet that this category of flow (request → pending → confirmed-out-of-band) is the right one for every provider this project is likely to add, not only the first.

**Signing in claims anonymous decks.** The join point between "decks already exist with `owner: "Anonymous"`" and "a person now has an authenticated identity" is defined as claiming — an authenticated session takes ownership of decks it can already reach (by local machine, by explicit selection, the exact mechanics are [E6.T9]'s to decide) rather than the decks being recreated or re-attributed by any automatic heuristic.

## Considered Options

- **No `owner` field until sign-in ships**: rejected for the migration reason above — every deck created before sign-in exists would need retroactive attribution, guessed at or left permanently null, the moment identity does ship.
- **A synchronous identity interface** (password/local-account style, resolved within one call): rejected — it is the shape that would need reshaping, not extending, once a real out-of-band provider is wired in, for no benefit today: nothing in this product currently calls the interface synchronously either.
- **Fold this decision into ADR-0020**: rejected, deliberately — the container-format trade-offs (single file, no archive tool, WAL rejected) and the identity trade-offs (asynchronous provider shape, claiming semantics) are unrelated; merging them would make both harder to cite on their own later, for two decisions that will each keep evolving independently.

## Consequences

- `owner` round-trips untouched through every operation that preserves unknown `project.json` fields (ADR-0003) — nothing about this ADR changes that mechanism, it only gives one more field a defined, always-present default.
- `deck ls --owner <name>` is the only filter this ADR adds; broader multi-owner queries (list every deck a signed-in identity owns, across machines) are [E6.T9]/cloud-edition scope, not decided here.
- Until [E6.T9] ships, every deck in practice carries `owner: "Anonymous"` — this is expected, not a bug to work around.
