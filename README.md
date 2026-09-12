# Slidra: An AX- and UX-Friendly Presentation Editor Powered by Slide Harness

> **AI can already generate slides. Slidra gives humans and agents a reliable way to keep improving them together.**

Slidra is an AI-native presentation system built around two core ideas:

1. **Open-ended generation requires a governed harness.**
2. **Humans and agents need distinct, native interfaces for working on the same shared document.**

Rather than treating a generated deck as disposable output, Slidra turns it into an inspectable, editable, and validatable presentation. Humans edit visually through the GUI, while agents inspect and modify the same presentation through a structured CLI.

Both work on the same `.slidra` document.

```text
Generate → Inspect → Edit → Validate → Refine
                    ↑                 ↓
                    └─────────────────┘
```

The goal is not merely to improve the handoff from AI generation to manual cleanup. It is to create a shared workflow in which that handoff gradually disappears.

---

## Why Slidra?

Many AI slide projects already demonstrate impressive generation:

```text
Prompt → Deck
```

But real presentation work continues long after the first draft:

```text
Prompt
  → Draft
  → Review
  → Local edits
  → Validation
  → More edits
  → Presentation
```

Without persistent structure, every revision risks becoming another generation task. The model must reconstruct the deck, infer the intended scope, preserve unrelated content, and evaluate its own output.

Slidra changes this responsibility model.

> For the full argument, see [Why Slidra When AI Can Already Generate Slides](docs/why-Slidra-when-AI-can-already-generate-slides.md) ([繁體中文](docs/why-Slidra-when-AI-can-already-generate-slides_zh.md)).

The agent still contributes research, writing, reasoning, and visual creativity. Reliability comes from the system around it: a structured document, bounded commands, operational guidance, and executable validation.

---

## What Makes Slidra Different?

### 1. Generation Runs Inside a Governed Harness

Slidra defines four boundaries for reliable agent workflows:

| Boundary           | Slidra component                | Purpose                                  |
| ------------------ | ------------------------------- | ---------------------------------------- |
| **Representation** | `.slidra` format                | Defines what exists and can be inspected |
| **Action**         | CLI                             | Defines what can be changed              |
| **Behavior**       | Skills and operational guidance | Defines how work should proceed          |
| **Validation**     | Executable validators           | Defines what must remain true            |

> Representation makes slides inspectable. Commands make them operable. Guidance makes the process disciplined. Validation makes the result accountable.

Together, these boundaries allow an agent to do more than generate. It can inspect the current state, perform a bounded operation, receive concrete feedback, and continue refining the result.

### 2. Humans and Agents Get Native Interfaces

Slidra does not force agents to operate a human-oriented GUI, nor does it force humans to describe every visual adjustment through chat.

- **Humans** use a direct, visual, UX-friendly editor.
- **Agents** use a structured, programmable, AX-friendly CLI.
- **Both** work on the same `.slidra` document.

The GUI routes supported edits through the same command layer used by agents. This preserves object identity and document continuity as control moves between humans and agents.

```text
Human ── Visual Editor ──┐
                         ├── CLI ── .slidra
                 Agent ──┘
```

Different interfaces, one presentation.

---

## Single-source-of-turth: The `.slidra` Format

A `.slidra` document is a ZIP container—not a single SVG file.

```text
deck.slidra
├── project.json      # formatVersion, name, canvas { width, height }, slides[]
├── slides/
│   ├── 001.svg
│   └── 002.svg
├── templates/        # optional, addressed and edited like slides
├── assets/
├── fonts/
└── plan/             # optional design-plan metadata (outline.md, design-spec.md)
```

`project.json` is the deck's own manifest: it lists which slides exist and in what order, the shared canvas size, and the format version the reader must support—so opening a deck never depends on scanning the filesystem to infer structure.

Each slide is stored as an authoritative SVG document. Around this visual foundation, Slidra adds presentation semantics such as:

- Deck and slide ordering, declared in `project.json`
- Canvas dimensions shared across every slide
- Stable, opaque `el-`-prefixed object IDs—every element an agent can address keeps the same ID across edits, undo, and redo
- Object names and locking (`data-slidra-lock`) so layout skeletons stay protected from routine edits
- Nested groups and z-order
- Packaged assets and fonts, so the file renders identically on any machine
- Charts and tables as first-class, individually addressable objects
- Speaker notes and comments, including comments pinned to a specific element
- Object animations and timing, and slide transitions
- Templates and design-plan metadata (`plan/outline.md`, `plan/design-spec.md`) that downstream validation reads back

This makes presentation state persistent and inspectable rather than dependent on a model's temporary understanding.

---

## Slidra CLI

Agents modify presentations through semantic CLI commands instead of rewriting entire slides. The CLI exposes 88 commands, grouped by what they act on:

| Family | Commands act on | Examples |
| --- | --- | --- |
| Presentation lifecycle | the `.slidra` file itself | `new`, `open`, `pack`, `cat`, `ls`, `convert`, `undo`, `redo` |
| `text` / `textbox` | text content, styling, and lists inside a text box | `text set`, `text style set`, `text list set`, `textbox add`, `textbox width`, `textbox align` |
| `element` | any object: position, size, order, grouping | `element move`, `element scale`, `element resize`, `element rotate`, `element group`, `element align`, `element distribute`, `element copy`/`cut`/`paste` |
| `table` | table structure and content | `table create`, `table cell set`, `table row insert`, `table theme set`, `table bind` |
| `chart` | chart data and appearance | `chart create`, `chart data set`, `chart type set`, `chart axis set` |
| `effect` | animations attached to an object or group | `effect add`, `effect set`, `effect move`, `effect list` |
| `slide` | slide-level properties | `slide add`, `slide set`, `slide background set`, `slide transition set`, `slide render` |
| `template` / `comment` / `plan` | reusable layouts, pinned feedback, design metadata | `template add`, `comment add`, `plan set` |
| `presentation`, `font`, `asset` | canvas size, embedded fonts, imported media | `presentation canvas set`, `font import`, `asset import` |
| `validate` | the whole deck, or one slide | `validate` |

A typical agent session composes a handful of these:

```sh
# Inspect the presentation
slidra ls <deck-id> slides
slidra cat <deck-id> slides/001.svg

# Change a single title
slidra text set <deck-id> slides/001.svg el-title \
  "A New Title"

# Move a single object
slidra element move <deck-id> slides/001.svg el-image \
  --dx 20 --dy 0

# Group existing objects
slidra element group <deck-id> slides/001.svg \
  el-image,el-caption

# Add an animation to the returned group ID
slidra effect add <deck-id> slides/001.svg <group-id> \
  --family enter \
  --effect fade \
  --start on-click \
  --duration 0.6

# Validate the result
slidra validate <deck-id> --json
```

A request to move one image should move one image—not regenerate the entire slide. Every command returns `{ ok, data, message, failureKind }`; exit code is always `0` on success and `1` on failure, and `--json` gives any command a single-line, script-friendly output.

### Executable Validation

Slidra produces machine-readable validation findings:

```json
{
  "checked": 6,
  "errors": [
    {
      "slide": "slides/002.svg",
      "element": "el-abc",
      "rule": "text.bullet-length",
      "actual": "37 characters",
      "limit": "≤ 32 characters",
      "message": "Page 2, bullet 3 has 37 characters, limit is 32"
    }
  ]
}
```

`validate` checks a deck (or a single slide) against rules grouped by concern:

- **Geometry**—`geometry.right-overflow`, `geometry.bottom-overflow`, `geometry.text-overlap`
- **Text density**—`text.title-length`, `text.bullet-length`, `text.bullet-lines`, `text.bullet-count`, `text.page-total`
- **Style**—`style.font-size`, `style.text-fill`, `style.shape-fill`
- **Structure**—`structure.background`, `structure.background-image`, `structure.notes`, `structure.template`, `structure.scrim`
- **Motion**—`motion.enter`, `motion.transition`
- **Roster and rhythm**—`roster.page-count`, `roster.page-type`, `roster.relationship-variety`, `rhythm.breathing-cards`, `rhythm.repeated-shape`
- **Diagram roles and blueprints**—`role.required`, `role.node-label`, `role.edge-endpoints`, `role.spine-count`, `blueprint.required`, `blueprint.nodes`, `blueprint.steps`
- **Taboos**—`taboo.thank-you`, `taboo.duplicate-cover`, `taboo.stroke`

Geometry, structure, and taboo rules run on any deck; the rest activate once the deck carries a `plan/outline.md` or `plan/design-spec.md`, so a plan-driven build gets stricter feedback than an ad hoc one. A non-zero exit code means "issues were found," not "the command failed"—`ok` stays `true` and the report is printed either way.

Validation provides concrete feedback for the next operation. It does not claim to offer universal visual QA, nor does it automatically repair every issue it identifies.

**Slidra enables a validation loop; it does not pretend that the loop closes itself.**

---

## The Product Experience

Slidra is designed to feel less like switching between an AI generator and a traditional editor—and more like collaborating with an agent directly inside the presentation.

A typical workflow might look like this:

```text
Agent creates a draft
  → Human adjusts the composition visually
  → Human pins a comment to an object
  → Agent modifies that object through the CLI
  → The canvas displays the updated document
  → Validation reports concrete findings
  → Human or agent makes the next correction
```

This enables users to:

- Start with AI without becoming trapped in generated output
- Continue editing through direct manipulation
- Request targeted changes instead of regenerating everything
- Preserve stable object identity across the GUI, CLI, comments, and validation
- See human and agent edits reflected in the same presentation
- Move fluidly between manual and agentic workflows

---

## UX-Friendly and AX-Friendly

### UX-Friendly for Humans

The visual editor supports interactions such as:

- Selection and multi-selection
- Dragging, resizing, scaling, and rotation
- Alignment and distribution
- Grouping and ungrouping
- Z-order management
- In-place text editing
- Style editing
- Animation controls
- Comments
- Shared undo and redo
- Playback and fullscreen viewing

These interactions are not legacy behaviors that AI should replace. Direct manipulation is often the fastest and most precise way for people to express visual intent.

### AX-Friendly for Agents

The CLI allows agents to:

- Inspect persistent presentation state
- Address objects through stable IDs
- Apply operations with limited scope
- Compose commands into workflows
- Manage groups, layouts, and animations
- Receive structured validation findings
- Continue working from concrete feedback

An AX-friendly interface does not imitate a mouse. It exposes the semantics behind each action.

---

## Getting Started

```sh
npm run verify:setup
```

This installs dependencies, builds the CLI, and starts a local server with a demo deck ready to explore. Pass `--blank` to start from an empty deck instead.
