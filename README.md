<!-- <p align="center">
  <img src="docs/assets/logo.svg" width="120" alt="Slidra">
</p> -->

<h1 align="center">Slidra</h1>

<p align="center">
  <b>UX-AX Unified Editor with Slide Harness</b><br/><br/>
  AI can generate slides. Slidra makes them a reliable shared workspace for humans and agents.
  
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"></a>
  <!-- Public demo link intentionally hidden until launch. -->
</p>

<p align="center">
  <img src="assets/hero.png" width="800" alt="An agent detects and fixes a text-overflow issue while the slide updates live.">
</p>

---

## Why Slidra?

AI can already create an impressive presentation.

The harder question is: **what happens after the first draft?**

```text
Prompt → Draft → Review → Local edits → Validation → More edits → Presentation
```

Real presentation work is iterative. Titles change. Images move. Diagrams evolve. Animations need adjustment. Humans and agents take turns refining the same material.

Without a structured environment, an agent may modify the deck through open-ended interpretation—deciding for itself what exists, what should change, how broadly to act, and whether the result is still valid.

> Read the full rationale in [Why Slidra When AI Can Already Generate Slides](docs/why-Slidra-when-AI-can-already-generate-slides.md) ([中文](docs/why-Slidra-when-AI-can-already-generate-slides_zh.md)).

## How It Works?

Slidra addresses this challenge through two connected shifts.

### Part I — From Open-Ended Generation to a Governed Harness

Slidra places agent work inside four explicit boundaries:

| Boundary | Component | Purpose |
| --- | --- | --- |
| **Representation** | `.slidra` format | Makes the deck inspectable |
| **Action** | `slidra` CLI | Defines what can be changed |
| **Behavior** | Skills and guidance | Defines how work should proceed |
| **Validation** | Executable validators `slidra validate` | Defines what must remain true |

The agent still researches, reasons, writes, and designs. But it works within a system that makes presentation state inspectable, changes bounded, and results accountable.

```text
Inspect → Act → Validate → Refine
```

### Part II — From One-Sided Adaptation to a Shared Medium

Reliable agent operations are only half of the product.

Humans should not have to describe every visual intention in a chat box. Agents should not have to imitate a mouse inside an interface designed for people.

Slidra gives each participant a native interface:

- **Humans** work visually through a UX-friendly editor.
- **Agents** work programmatically through an AX-friendly CLI.
- **Both** modify the same `.slidra` document through the same command layer.

```text
Human → Visual editor ┐
                      ├→ `slidra` CLI → `.slidra` document
Agent →     ACP   ────┘               ↓
                                  Validate
```

The goal is not a better handoff between AI generation and manual editing. **The goal is to make the handoff disappear.**

In practice, human–agent collaboration becomes a continuous refinement loop:

```text
Agent drafts the deck
  → Human adjusts the layout
  → Human pins a comment to an object
  → Agent edits that object through the CLI
  → The canvas updates
  → Validation reports remaining issues
  → Human or agent makes the next correction
```

## `.slidra` Deck Format

A `.slidra` file is a ZIP container with an explicit project manifest and authoritative SVG slides:

```text
deck.slidra
├── project.json      # format, name, canvas, and slide order
├── slides/
│   ├── 001.svg
│   └── 002.svg
├── templates/        # optional reusable layouts
├── assets/
├── fonts/
└── plan/             # optional outline and design specification
```

`project.json` declares the slide order, canvas size, and format version. Each slide is stored as SVG, with presentation semantics layered on top:

- Stable `el-`-prefixed object IDs
- Object names, locking, groups, and z-order
- Packaged assets and fonts
- Addressable charts and tables
- Speaker notes and element-pinned comments
- Object animations and slide transitions
- Templates and design-plan metadata

The document stores the current state instead of leaving it inside an agent’s temporary interpretation.

For humans and agents alike, the `.slidra` document is the single source of truth.

## `slidra` CLI

Slidra provides 88 commands for precise presentation editing:

| Family | Examples |
| --- | --- |
| Presentation | `new`, `open`, `pack`, `cat`, `ls`, `undo`, `redo` |
| Text | `text set`, `text style set`, `textbox add`, `textbox align` |
| Elements | `element move`, `resize`, `rotate`, `group`, `align`, `distribute` |
| Tables | `table create`, `table cell set`, `table row insert`, `table bind` |
| Charts | `chart create`, `chart data set`, `chart type set`, `chart axis set` |
| Motion | `effect add`, `effect set`, `slide transition set` |
| Slides | `slide add`, `slide set`, `slide background set`, `slide render` |
| Resources | `template add`, `comment add`, `font import`, `asset import`, `plan set` |
| Validation | `validate` |

A typical agent workflow looks like this:

```sh
# Inspect
slidra ls <deck-id> slides
slidra cat <deck-id> slides/001.svg

# Edit one object
slidra text set <deck-id> slides/001.svg el-title "A New Title"
slidra element move <deck-id> slides/001.svg el-image --dx 20 --dy 0

# Validate
slidra validate <deck-id> --json
```

A request to move one image should move one image—not regenerate the slide.

Every command returns:

```json
{ "ok": true, "data": {}, "message": "", "failureKind": null }
```

Commands exit with code `0` on success and `1` on failure. Add `--json` for single-line, script-friendly output.

## Quickstart

```sh
git clone https://github.com/Noopher-AI/slidra.git
cd slidra
npm run verify:setup
```

This installs dependencies, builds the CLI, and starts a local server (`slidra serve`) with a demo
deck open in the web editor.

To begin with an empty deck instead:

```sh
npm run verify:setup -- --blank
```

From there, point an agent at the CLI shown in [CLI](#cli): inspect the deck with `ls`/`cat`, make a
bounded edit, and run `validate`.


## Architecture

Slidra is a monorepo with a Next.js and React web editor, a resident Node.js server, and a Rust CLI that owns all presentation-content reads and writes. `slidra serve` serves the editor alongside the open deck and connects its chat to Claude Code, Codex, or Pi through ACP. Pi currently targets a local Qwen server through its OpenAI-compatible API. The web editor never accesses a `.slidra` deck directly: it sends read requests and semantic edit commands to the application server, which executes the corresponding `slidra` CLI commands.

```mermaid
flowchart LR
    Browser["Browser"] --> Edge["Hosted demo edge"]
    Edge -->|"static app"| Web["Web editor"]
    Edge -->|"/api/*"| Server["Application server"]
    Web -->|"read requests"| Server
    Web -->|"edit commands"| Server
    Server -.->|"SSE updates"| Web
    Agent["Agent integration"] -->|"ACP"| Server
    Server -->|"cat / ls / render"| CLI["slidra CLI"]
    Server -->|"semantic edits"| CLI
    Agent -->|"shell"| CLI
    CLI <-->|"read / write"| Deck[".slidra"]
```

| Component | Frameworks and languages | Responsibility |
| --- | --- | --- |
| Hosted demo edge | Vercel Routing Middleware, TypeScript | Authenticates visitors, serves the Next.js static export, and forwards authenticated `/api/*` traffic to the private `slidra serve` origin. |
| Web editor | Next.js 16, React 19, TypeScript, HTML, CSS | Renders the editor and sends presentation read requests and semantic edit commands to the application server. It never accesses `.slidra` directly. |
| Agent integration | Agent Client Protocol, TypeScript | Connects Claude Code, Codex, or local-Qwen-backed Pi to the resident server while keeping deck changes inside the CLI command surface. |
| Application server | Node.js 22, TypeScript, native `node:http` | Runs `slidra serve`, exposes the JSON and SSE endpoints, and translates Web requests into `slidra` CLI read or write commands. |
| `slidra` CLI | Rust 1.85, Rust 2024 Edition, Clap, Serde | Implements reads, semantic edits, validation, undo and redo. It is the only presentation-content boundary for `.slidra`. |
| `.slidra` | ZIP, JSON, SVG | Stores the manifest, ordered slides, templates, assets, fonts, and optional planning documents in one `.slidra` file. |

The local and hosted paths use the same frontend build and the same server and CLI contracts. Vercel hosts the static Next.js output and protects the public edge; it does not replace the stateful Node.js server or the Rust command engine.


## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, branching, and DCO sign-off
requirements. Issues labeled
[`good first issue`](https://github.com/Noopher-AI/slidra/labels/good%20first%20issue) are a good
place to start. Changes to the `.slidra` file format go through an RFC under `spec/rfcs/` rather than
a direct PR.


## License

[Apache-2.0](LICENSE)
