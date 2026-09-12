# Motion is an ordered list of effects, not element attributes

ADR-0005 originally expressed motion data as element attributes (`data-slidra-step`, `data-slidra-enter`). That part of the attribute design is now retired, in favor of each slide holding an ordered list of effects, each entry pointing at an element.

Both PowerPoint and Keynote take this shape. PowerPoint stores animation in `<p:timing>`, a tree entirely separate from the shape tree `<p:spTree>`, pointing at shapes through `<p:spTgt spid="…">`; Keynote's build lists are isomorphic. Both organize effects into families (enter, emphasis, exit, path), and media play/pause is itself an effect item in the list rather than a separate mechanism; every item carries its own start trigger (on click / with previous / after previous).

The attribute-based design had a structural ceiling: an element could only carry one effect. "Appear at step 2, get emphasized at step 5, exit at step 7" can't be expressed without inventing a mini-syntax inside an attribute value, which is worse than either alternative. A list also makes "insert an effect in the middle" a simple splice, rather than renumbering every subsequent element — the same reasoning ADR-0003 applied when choosing an explicit `slides` array, and ADR-0008 applied when choosing a self-contained slide, applied here a third time.

The list is written into the slide SVG's `<metadata>` as custom-namespaced XML elements rather than inline JSON: the whole file keeps a single syntax, so anyone or any agent reading it never has to switch parsers mid-file, or deal with CDATA and quote-escaping. An unknown namespace is ignored by other vector tools, so ADR-0001's static compatibility is unaffected.

## Consequences

- A "step" is no longer stored — it's derived: the runtime groups the list into clusters based on each item's start trigger, and each cluster starting with "on click" is one step.
- Every effect item points at an element; that's an invariant of the model. Audio therefore also has to attach to a visible element (which doubles as a future selection handle for visual editing) rather than existing as a special case that points at nothing.
- Deleting an element leaves any effect items pointing at it dangling, and they must be cleaned up — this is the one new failure mode introduced by this decision, and it's the responsibility of the element-delete command.
- XML attribute values are all strings, so future `duration`/`delay` values need their own type coercion. That's the cost of choosing a single syntax.
- Everything else in ADR-0005 is unaffected: still no SMIL or CSS animation, still no `<foreignObject>`, audio/video still expressed as a visible placeholder element with `data-slidra-media`.

## Revision: four families, timing parameters, group animation, and paths

The original version only implemented the `enter`/`media` families, and had no `duration`/`delay`. A later pass filled in the complete model this ADR describes:

```xml
<slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
  <slidra:effect target="el-a3f2c1" family="enter"    effect="fade"  start="on-click"       duration="0.6" delay="0"/>
  <slidra:effect target="el-7b91de" family="emphasis" effect="pulse" start="with-previous"  duration="0.8" delay="0.2"/>
  <slidra:effect target="el-2c9f10" family="path"     effect="path"  start="after-previous" duration="1.2" delay="0" d="M 100 200 C 300 100 500 300 700 200"/>
  <slidra:effect target="el-group"  family="enter"    effect="zoom"  start="on-click"       duration="0.6" delay="0"/>
</slidra:effects>
```

- `family` is one of `enter`/`emphasis`/`exit`/`path`/`media` (a fixed set, defined in `@slidra/core/effects`); `start` supports all three triggers (`on-click`/`with-previous`/`after-previous`).
- `duration`/`delay` are optional, in seconds, defaulting per family when absent (`media` defaults to 0, everything else to 0.6). Valid values are "finite, non-negative numbers" — a malformed or negative value always throws, and is never silently clamped to something valid.
- A `family="path"` effect item carries an additional `d` attribute, whose syntax is SVG path data in the slide's coordinate space; `d` is a valid but unused attribute on other families, and is preserved as-is.
- **Group animation**: an effect item's `target` can point at a group `<g>` rather than only a leaf element — this falls out naturally from the same schema as "several separate elements, each with its own item," not as an extra branch.
- Order in the effect list is identity: the `slidra effect` command family addresses items by 1-based position, with no separate id invented for them. `effect list`'s output is likewise 1-based, so the `index` it reports can be fed straight into `move`/`set`/`remove` — internally, `Effect.index` (the array position) in the core library remains 0-based; only the CLI's `effect list` output converts it once before printing.
- The namespace constant is consolidated to a single source in `@slidra/core/effects` (`https://slidra.app/ns/2026`); an earlier bug in the clipboard code used a different, incorrect namespace, which caused pasted effects to be silently treated as nonexistent during playback — this has been fixed, and the whole codebase now has exactly one source for the namespace literal.
- The effect list got its first real write path (`slidra effect add/remove/move/set`); previously there was only a read path and incidental cleanup of dangling items on element delete.
