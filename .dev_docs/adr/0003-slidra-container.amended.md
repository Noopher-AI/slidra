# A presentation is a single `.slidra` container file; the working directory is hidden

> **⚠️ Partially superseded.** The internal structure of `project.json` + `slides/00N.svg` + `assets/` is extended by **ADR-0016** to a fourth directory: `fonts/`, registered under a new optional `fonts` field in `project.json`. **Everything else** — `project.json` only holds what SVG can't express, `formatVersion` is never omitted, and page order is an array — is unaffected.
>
> **Later revision**: `formatVersion` moved from 3 to 4 (`templates` must be an object shape, the `transition` field is forbidden, `fonts` becomes required), with the full 1→2→3→4 migration rules settled in `docs/spec/slidra-format.md`; this ADR no longer tracks version-by-version detail.

> The container layout, the complete type and required-ness of every `project.json` field, and the version-by-version `formatVersion` migration rules are authoritative in [`docs/spec/slidra-format.md`](../../docs/spec/slidra-format.md); this ADR only records why `formatVersion` exists and why the container takes this shape.

Users expect a presentation to be "one file" — something they can copy, send, and back up. But staying compressed while editing isn't practical: a presentation with embedded video would need tens of megabytes re-compressed for a single character change.

So `.slidra` is a storage-and-transport format (a zip). `slidra open` unpacks it to `~/.slidra/work/<id>/` for editing, and repacks it on close or save. This is the same model Keynote and LibreOffice use.

The working directory is deliberately placed somewhere neither the user nor an agent will ever come across, rather than sitting alongside the `.slidra` file — see ADR-0004.

## Consequences

- Internal structure is `project.json` + `slides/00N.svg` + `assets/`. **The fourth directory, `fonts/`, is described in ADR-0016.**
- `project.json` only holds what SVG can't express: `formatVersion`, `name`, `canvas`, the `slides` order array (**and the `fonts` array added by ADR-0016**). Shared styles do not live here — otherwise opening a single slide on its own would be missing colors, violating ADR-0001.
- `formatVersion` is never omitted; it is the sole basis for migrating old files in the future.
- Page order uses an explicit array rather than filename ordering, to avoid mass renaming when the order changes.
- Author comments pinned to a presentation do not live in `project.json` — they live in each slide SVG's own `<metadata>`, as detailed in ADR-0008.
- The presentation-level `transition` field in `project.json` (a single transition for the whole deck, which was never actually played) has been retired in favor of each slide SVG's own `<slidra:transition>`. `formatVersion` moved 2 → 3; when an old `.slidra` is opened, that field's value (if previously set to `"fade"`) is migrated into each page's `<slidra:transition>` and then removed from `project.json` — with no compatibility layer left behind.
