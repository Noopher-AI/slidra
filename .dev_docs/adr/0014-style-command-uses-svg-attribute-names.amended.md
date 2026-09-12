# Styling uses one generic command, with SVG attribute names, gated by an allowlist

> **This ADR has been extended with a section for tables; the allowlist itself gains no new entries.** See "Tables and the style allowlist" at the end.

> **This ADR revokes one clause of ADR-0002.** That ADR wrote: "commands must be semantic (`text set`, `element move`), not generic low-level attribute operations — otherwise an agent would need to be fluent in SVG before it could issue a command, which defeats the product's premise." The second half of that premise is explicitly abandoned here. The rest of ADR-0002's decisions (the CLI is the only vocabulary, `serve` is its resident mode, the frontend must never have a capability the CLI lacks) are completely unaffected — that's still its core.

There are a lot of style properties: fill, stroke color and width, opacity, corner radius, font, size, weight, text color, alignment, line height. One command per property would mean twenty-odd commands for styling alone, and the command set would drown — "the command set itself is the product spec" only holds up if the list stays short enough for someone to actually read.

So styling goes through **one generic command**, with attribute names taken **directly from SVG**:

```
element style set el-box   fill "#c43e1c"
element style set el-title font-size 40
```

The trade-off is stated honestly: ADR-0002's whole argument was "an agent shouldn't need to be fluent in SVG" — this amounts to saying "actually, it's fine, since a coding agent already knows what `fill` and `stroke` are." That judgment changed, and it's recorded here.

## Properties go through an allowlist

Settable properties are enumerated in a table; anything not on it errors. **Geometric properties (`transform`, `x`, `y`, `width`, `height`) and every `data-slidra-*` attribute are explicitly excluded** — each has its own dedicated command.

**The allowlist isn't there to stop an attacker — it's there to stop commands from fighting each other.** ADR-0010 already established that slide content is always untrusted, with the sandboxed iframe as the actual line of defense, and explicitly rejected server-side sanitization; whether a `filter` attribute can be set doesn't change the security posture at all.

The real reason is ADR-0012: position and rotation are only ever written on the container's `transform`. If the style command could set any attribute at all, an agent could bypass `element move` and hard-code coordinates onto a primitive itself — the picture would look right until someone drags it or adds it to a group, at which point the position suddenly jumps, because now two places disagree about where it is. The same applies to `width`/`height` (bypassing the scaling rules) and `data-slidra-*` (bypassing lock markers and dynamic text).

ADR-0002 has a line that speaks to exactly this: invariants should be structural guarantees, not discipline. The allowlist is that structure.

## Considered Options

- **One command per property** (`element fill`, `text size`, `text align`…): closest to the original ADR-0002, each command can validate its own value range, and `--help` is a complete capability list. The cost is the sheer number of commands.
- **One generic command, but with the product's own domain vocabulary for property names**, paired with an enumeration command (`color`, `border-width`, `font-size`…): fewer commands, and "an agent doesn't need to be fluent in SVG" stays intact. The cost is maintaining a mapping table between the product's property names and SVG attributes, updated in two places every time a new style is added.

## Consequences

- **The editing contract has to teach the agent that this command exists and where the allowlist's boundaries are**, rather than relying on it to discover capabilities by reading `--help` command by command.
- **The allowlist is now the spec for styling capability.** Adding a new style means adding one row to the table — that's lightweight, but it also means nobody gets nudged by `--help` that it exists.
- What the style panel displays matches the allowlist one-to-one. A property not on the table is never shown in the panel, even if it's present in the file (say, from an imported SVG).
- Value-range validation still happens, just hung off the allowlist table rather than off individual commands.

## Tables and the style allowlist

`element style set` always errors on a table container ("element <id> is a table; use the `table` command family to adjust its style") — for the same reason as ADR-0012's scaling/grouping restrictions on tables: a table's settable style is split between the container level (theme, header) and the cell level (`table cell style set`'s align/fill/text-fill/font-weight), both owned by the `table` command family; `element style set` never touches either.

`STYLE_ATTRIBUTE_WHITELIST` (in `packages/core/src/element-edit.ts`) and its frontend mirror `packages/web/src/style-attrs.ts` **gain no new entries** — the allowlist still only answers "what's the style capability of a general element"; a table's capability list is `table --help`, and doesn't piggyback on this table. Cell-level `data-slidra-`-prefixed attributes are rejected the same way (following the existing `data-slidra-` prefix ban), but the validation for that is written separately, in `table cell style set` inside `table/edit.ts`, and never consults this shared allowlist.
