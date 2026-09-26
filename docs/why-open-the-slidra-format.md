# Why We Are Opening the `.slidra` Format

[Multilingual: [中文](./why-open-the-slidra-format_zh.md)]

**A slide format built on an open standard, with coordinates a model can reason about, and a player anyone can run.**

## TL;DR

- Slidra is a product built around four boundaries for AI-assisted presentation work: a **representation** (the `.slidra` format), an **action** surface (the CLI), **behavior** (skills and guidance), and **validation**. This repository opens the first one, the representation, together with a reference viewer that plays it.
- The representation is the boundary worth sharing. Commands, guidance and validators are ways of working on a deck. The format is the deck. Once it is open, anyone can build their own generator, editor, validator or player around it.
- `.slidra` is built on **SVG**, a W3C standard every browser already renders. Each slide is a complete, readable SVG document, not a proprietary intermediate.
- SVG places every object at **explicit coordinates on a fixed canvas**. For an AI system, layout becomes arithmetic it can do and check, not an emergent result of a layout engine it cannot see.
- On top of SVG, the format adds only what a presentation needs: slide order, stable object IDs, declarative animations and transitions, speaker notes, embedded fonts and media. All of it lives in one self-contained file.
- The viewer is the reference for how a deck *plays*, and for how to show slide content an AI generated without trusting it.

---

## The Missing Piece Is a Target

AI slide generation has already moved from demo to practice. Models can research a topic, structure a narrative and produce a complete deck. But look at what these systems produce, and you find a patchwork: HTML pages with a custom slide script, Markdown dialects, images of slides, or PowerPoint files written through a library that hides most of the format.

Each choice makes sense locally. Together, they mean that a generated deck is usually tied to the tool that made it. Moving it to another tool is lossy. Editing it afterwards is often impossible, and what the model produced cannot be checked without rendering it.

**What the ecosystem lacks is not another generator. It is a shared target: a format designed so that machines can write it well, humans can present from it, and any tool can read it.**

That is the part of Slidra we are opening.

---

## Part I — Why SVG

### An open standard, not a new invention

SVG is a W3C standard. It has been implemented in every browser for over a decade and is supported by design tools, document pipelines and graphics libraries in every major language. A `.slidra` slide is a valid SVG document: open one in a browser and you see the slide.

So the format builds on a mature, widely implemented rendering model instead of inventing one. Anyone who wants to read a deck needs no Slidra code to draw a slide. The hard part, rendering vector graphics, text, gradients, images and clipping correctly, is already done in every browser.

### The slide is the artifact

In many presentation formats, what is stored is an intermediate description that some renderer later turns into a picture. The stored document and the rendered result can drift apart, and the rules connecting them live inside the renderer.

In `.slidra`, the SVG *is* the rendered slide. The format adds no second layout layer on top of it. What a model writes, what a person inspects and what the audience sees are the same document.

### Models already speak it

SVG is plain text, and it appears in huge quantities across the public web: icons, diagrams, charts, illustrations. Language models have seen a great deal of it. Asking a model to produce an SVG slide asks it to use a vocabulary it already knows, not a bespoke schema it has to learn from a prompt.

---

## Part II — Why Coordinates Matter for AI

### Position is stated, not emergent

In HTML and CSS, where an element ends up depends on flow layout, font metrics, the viewport, inherited styles and the order of other elements. The position is *emergent*: to know it, you must run the layout engine. A model writing HTML slides is writing instructions for a system whose output it cannot see.

In SVG, position is *stated*. Every slide has a fixed canvas, `viewBox="0 0 1280 720"`, and every element sits at explicit coordinates:

```xml
<g id="el-Ab3xK9mQ2pLw" data-slidra-name="Title" transform="translate(96 160)">
  <text x="0" y="0" font-size="64" fill="#f4f6f8">Quarterly Review</text>
</g>
<g id="el-Qm7Rt2Lp9xZa" data-slidra-name="Chart" transform="translate(96 240)">
  <rect x="0" y="0" width="520" height="360" rx="12" fill="#1a1d23"/>
</g>
```

The title is at (96, 160). The chart occupies x 96–616 and y 240–600. Nothing else will move them.

### Layout becomes arithmetic

When positions are numbers, layout decisions become calculations a model is good at and can show its work for:

- **Alignment**: two elements are left-aligned when their x values match.
- **Spacing**: the gap between the title baseline and the chart is 240 − 160 = 80.
- **Containment**: an element fits the canvas when x + width ≤ 1280 and y + height ≤ 720.
- **Overlap**: two boxes collide when their intervals intersect on both axes.
- **Grids**: a four-column layout with 96 px margins and 32 px gutters is a formula, not trial and error.

A model can plan a slide on paper, write it, and then reason about the result from the document alone. So can a program. Checks like overflow, overlap, alignment and spacing can be computed from the file without a screenshot and without a human looking.

### Text is laid out ahead of time

SVG has no automatic line wrapping, and the format uses that constraint on purpose. A text box stores its wrap width and its lines as explicit `<tspan>` elements. Wrapping is decided once, when the slide is written, and never re-flows differently on another machine. Together with fonts embedded in the file, the same deck produces the same lines in every conforming player.

We are honest about the cost: whoever writes a text box must measure text to wrap it. That measurement is a solvable, one-time problem for a generator, which is far better than a layout that silently changes between the author's screen and the audience's.

### Objects have stable identities

Every addressable object is a `<g>` container with an opaque, stable ID (`el-` plus 12 characters) and a human-readable name. Position and rotation live on the container's transform, never scattered across its primitives.

This gives a model, or any tool, a precise way to refer to "the chart on slide 3" that survives reordering, renaming and later edits. An agent can change one object without regenerating the slide around it. Animations point at objects through the same IDs.

---

## Part III — What `.slidra` Adds on Top of SVG

SVG describes a picture. A presentation needs a little more. The format adds exactly that, and nothing that breaks SVG:

| Need | How `.slidra` expresses it |
|---|---|
| Slide order and canvas | `project.json`: `name`, `canvas`, ordered `slides` |
| Addressable objects | `<g id="el-…">` containers with `data-slidra-name` |
| Animations | An ordered list of declarative effects in the slide's `<metadata>`: 20 effects in five families, with `on-click` / `with-previous` / `after-previous` timing |
| Page transitions | Per slide: `fade`, `slide`, `zoom`, with durations |
| Speaker notes, comments | `<slidra:notes>`, `<slidra:comments>` in `<metadata>` |
| Charts and tables | Their data plus the rendered SVG, in one container |
| Media | Video, audio and YouTube embeds, placed over an SVG placeholder |
| Dynamic text | `{{ slide_number }}`, `{{ slide_total }}`, `{{ presentation_name }}` |
| Fonts and assets | Embedded in the file, with licence metadata |

Two design choices deserve emphasis.

**Motion is data, not code.** An animation is a line like `<slidra:effect target="el-title" family="enter" effect="fade" start="on-click"/>`. A model does not have to write JavaScript to make something appear on click. It declares the intent, and every conforming player produces the same result. The playback specification defines what each effect does, down to its keyframes and the timing between effects.

**A slide is self-contained.** Everything about a slide, its graphics, IDs, effects, transition, notes and comments, lives in its own SVG. Reordering slides changes one array and nothing else. A single slide can be generated, replaced or inspected in isolation, which suits a model that works one slide at a time.

The whole deck is one SQLite file with one table, `content`, holding one row per path. There is no hidden working copy and no packing step, and a reader can fetch a single slide without unpacking the rest. It is still simple enough to read without a database engine: the viewer in this repository parses it with about 250 lines of dependency-free JavaScript.

---

## Part IV — Why a Reference Viewer

A format is only as real as the programs that read it. The viewer exists so that `.slidra` is useful from day one, and so that "how does this deck play?" has a concrete, inspectable answer.

- **It plays everything the format describes.** Effects, transitions, media, embeds, fonts, charts, tables, dynamic text and speaker notes, in any modern browser. It needs no build step and no dependencies, and nothing is uploaded.
- **It is the reference for playback.** The playback specification and the viewer's runtime describe the same behavior: which elements are hidden when a slide opens, how a step is scheduled, how going back replays a slide, and how transitions run.
- **It shows how to render untrusted slides.** A deck an AI generated, or a stranger sent you, is untrusted input, and a valid SVG can carry scripts. The viewer renders every slide in a sandboxed, opaque-origin frame with a Content-Security-Policy that admits only its own runtime. Slide scripts, event handlers and `javascript:` links never run. Anyone building on the format can copy this model instead of rediscovering it.

---

## What This Enables for the Community

- **Generator authors** can target `.slidra` instead of inventing yet another slide format. Their output becomes presentable, inspectable and editable by any tool that reads the format.
- **Tool builders** can write converters, linters, validators, accessibility checkers, search indexers or players without asking permission and without reverse-engineering anything.
- **Researchers** get a slide representation whose geometry can be scored directly from the document. Overflow, overlap, alignment and reading order become computable properties, which is useful for benchmarks and for training feedback.
- **Presenters and organizations** get decks that outlive the tool that made them: one open file, readable with a web browser and a short parser.

---

## What Is and Is Not Included

| Open, in this repository | Not included (Slidra Pro) |
|---|---|
| The `.slidra` format specification | The visual editor |
| The playback specification | The `slidra` CLI and its command vocabulary |
| The container RFC | Agent integration, skills and harness |
| A reference viewer and example decks | The validator and its rules |

The line is deliberate. The format is the common ground that tools, models and people should share. The editor, CLI, guidance and validation are one way to work on that ground. They are the product we build on it, and decks they produce play in the open viewer unchanged.

---

## Closing

AI can already draw slides. What it needs is a place to put them: a format that is an open standard underneath, stated precisely enough that a model can reason about every coordinate, and complete enough to carry a real presentation from first draft to the moment it is presented.

**We are opening `.slidra` so that the slides AI makes can be read, checked, presented and kept by anyone, not only by the tool that made them.**
