# Slidra — New v3 Handoff

AI-agent-first slide editor. This package is the **design handoff**: an interactive prototype, the design language, the meaning behind the interface, an imagined backend interface, BDD interaction specs, and the discussion log.

## Directory

| Path | Contents |
|---|---|
| `prototype/` | Runnable prototype (`Slidra (New v3).dc.html` + `slidra-logic-v3.js` + `support.js` + fonts). `reference/` holds the old-version rebuild and the v1 comparison |
| `docs/01-DESIGN_TOKENS.md` | Color, type, spacing, radius, shadow, glass material, and motion tokens |
| `docs/02-DESIGN_DOC.md` | Design principles, layout structure, state machines, data model, visual system |
| `docs/03-UI_RATIONALE.md` | The meaning and rationale behind every region and UI element |
| `docs/04-BACKEND_INTERFACE.md` | Imagined backend: TypeScript types, REST/WebSocket interface, agent protocol |
| `docs/05-INTERACTIONS.feature` | Frontend interaction patterns (Gherkin/BDD) |
| `docs/06-KEYBOARD_AND_GESTURES.md` | Keyboard shortcuts and mouse/gesture reference |
| `docs/07-DISCUSSION_LOG.md` | Discussion log (decisions made and options rejected) |
| `docs/08-KNOWN_GAPS_AND_ROADMAP.md` | What the prototype doesn't implement yet, suggested next steps |

## Running the prototype

The prototype dynamically loads `slidra-logic-v3.js` as an ES module, so it must be served over HTTP (not opened directly via `file://`):

```bash
cd prototype
python3 -m http.server 8080
# open http://localhost:8080/Slidra%20(New%20v3).dc.html
```

## Prototype structure

- `Slidra (New v3).dc.html`: a declarative template (all styles inline); the UI lives inside `<x-dc>`; the `<script data-dc-script>` at the bottom is a thin shell that dynamically loads the logic.
- `slidra-logic-v3.js`: `INITIAL_STATE` + the `Logic` class (state, history, elements, tables, chart SVG, animation, groups, canvas zoom, insert panel, AI comments). `renderVals()` flattens state into values the template can read.
- `support.js`: the template runtime (provided by a third party, not to be modified).
