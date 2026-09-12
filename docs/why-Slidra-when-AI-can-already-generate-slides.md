# Why Slidra When AI Can Already Generate Slides 

[Multilingual: [中文](./why-Slidra-when-AI-can-already-generate-slides_zh.md)]

**From open-ended generation to a governed harness—and from one-sided adaptation to a shared way of working.**

## TL;DR

- AI can already generate impressive slide decks. Slidra focuses on what comes next: placing that capability inside a governed harness while delivering both a UX-friendly and an AX-friendly experience.
- Slidra places open-ended generation inside a governed harness defined by four boundaries:
  - The SVG-based `.slidra` format defines what agents can inspect and understand.
  - The CLI defines how slides can be modified.
  - Skills and operational guidance define how agents should work.
  - Executable validation provides feedback for continuous refinement.
- Slidra delivers both UX-friendly and AX-friendly experiences, with the `.slidra` document serving as the single source of truth:
  - Humans work through a direct, visual, UX-friendly interface.
  - Agents work through a structured, programmable, AX-friendly CLI interface.
  - Although their interfaces are different, both human and agent actions modify the presentation through the same CLI and operate on the same `.slidra` document.
- The goal is not a better handoff between AI generation and manual editing. It is a shared way of working in which that handoff begins to disappear.

---

Open-source slide projects have shown that agents can research a topic, organize a narrative, generate visual content, and assemble a complete presentation. These are meaningful achievements. They have transformed slide generation from a speculative demo into a practical capability.

**We did not build Slidra because agents could not generate slides. We built it because generation alone does not create a reliable way of working.**

A generated deck is rarely the end of the process. Someone changes the title, moves a diagram, replaces an image, adjusts the timing of an animation, or asks the agent to revise one section without disturbing the rest. The real challenge begins after the first draft exists.

This leads to two questions. What structure does an agent need in order to keep working reliably after generation? And what kind of product allows humans to remain inside that process without giving up the way they naturally edit slides?

---

## Part I — From Generation to Governed Harness  

### The First Draft Is a Beginning  

The simplified story of AI slide creation looks like this:

```text
Prompt → Deck
```

But the actual lifecycle of a presentation looks more like this:

```text
Prompt → Draft → Review → Local edits → Validation → More edits → Presentation
```

Generation is one step in this sequence, not the sequence itself. A useful system must preserve context across revisions, support changes with limited scope, and make it possible to determine whether those changes damaged anything else.

### When the Model Owns the Entire Process  

In a generation-first system, every revision can become another generation task. The model must reconstruct the current state, infer which objects the request refers to, decide how much of the document to rewrite, and judge for itself whether the result remains valid.

This places too many responsibilities inside the model's temporary interpretation. The scope of a change may be ambiguous. Unrelated content may drift. Errors may remain invisible because the same system that produced the result is also being asked to evaluate it.

The problem is not that the model lacks intelligence. The problem is the allocation of responsibility: **the model is being asked to provide both creativity and control.**

### The Governance Shift  

In Slidra, control does not come from repeatedly asking the model to be more careful. It comes from placing the model inside a structured system.

The model still researches, reasons, writes, and makes visual decisions. But it does so within explicit boundaries that define what exists, what can change, how work should proceed, and what conditions the result must satisfy.

---

## The Four Boundaries of the Harness  

### 1. Representation: What Exists?  

A `.slidra` document is not a single SVG file. It is a ZIP container containing `project.json`, one authoritative SVG document for each slide, and packaged assets and fonts. It can also include templates, planning data, notes, comments, animation effects, and transitions.

SVG remains the visual foundation, but Slidra adds presentation semantics around it: slide order, canvas dimensions, stable opaque `el-*` object identifiers, names, locking, hierarchy, grouping, z-order, and timing relationships.

This gives agents something concrete to inspect. They can list the container, read `project.json`, examine a slide's SVG, identify existing objects, and retrieve ordered effects. Some geometric details still need to be interpreted from SVG attributes and transforms, but the state is stored in the document rather than existing only in the model's memory.

### 2. Action: What Can Change?  

The Slidra CLI defines how an agent changes presentation state. Its commands are semantic operations with limited scope: set the text of one object, move selected elements, align a group, change z-order, add an effect, or modify a transition.

For example, changing a title does not require regenerating the slide. Moving an image twenty pixels does not require rewriting the surrounding objects. The command states both the intended operation and its target.

```sh
slidra text set <id> slides/001.svg el-title "A New Title"
slidra element move <id> slides/001.svg el-image --dx 20 --dy 0
```

The same command surface supports both construction and refinement. An agent can create slides and objects, but it can also perform the smaller operations that dominate the later stages of real presentation work.

### 3. Behavior: How Should Work Proceed?  

Commands define what is possible, but they do not by themselves define good working discipline. Slidra therefore provides operational instructions and skills that tell agents how to use those commands responsibly.

The workflow is intentionally conservative: inspect the current slide before editing it, use existing object IDs rather than guessing, make the smallest necessary change, work incrementally, preserve established styles where possible, and validate the result before declaring the task complete.

These instructions turn isolated commands into a repeatable method. They reduce the chance that an agent will replace a precise editing task with an unnecessary rewrite.

### 4. Validation: What Must Remain True?  

Slidra's validator provides machine-readable findings with the slide, element, rule, actual value, expected limit, and explanatory message. Existing rules cover areas such as canvas overflow, text overlap and density, fonts and fills, structural requirements, notes, motion, and plan-related constraints.

```json
{
  "slide": "slides/001.svg",
  "element": "el-title",
  "rule": "geometry.text-overlap",
  "actual": "overlap detected",
  "limit": "no overlap",
  "message": "title overlaps another text element"
}
```

Validation is not yet a universal visual-quality judge, nor does it automatically repair every finding. Instead, it provides an independent feedback surface that an agent or human can use to decide the next operation. Slidra enables a validation loop; it does not pretend that the loop closes itself.

**Representation makes the slide inspectable. Commands make it operable. Guidance makes the process disciplined. Validation makes the result accountable.**

### A World in Which Agents Can Work  

Together, these four boundaries create a world in which an agent can do more than generate. It can inspect the existing state, perform a bounded action, receive concrete feedback, and continue from the result.

The harness does not replace the model's creativity. It gives that creativity a stable environment in which revision becomes cumulative rather than destructive.

---

## Part II — From Adaptation to a Shared Medium  

### Agent Reliability Is Not Human Experience  

A system can be excellent for agents and still be a poor product for people. A structured format, a capable CLI, and machine-readable validation may make automation reliable, but they do not make a chat box the ideal interface for editing a visual composition.

People edit slides spatially. They point, select, drag, resize, group, compare, and adjust. Asking them to translate every visual intention into prose would remove many of the advantages of direct manipulation.

### The Two Adaptations  

When agents are forced to operate a human-oriented GUI, they must reason through coordinates, visual targeting, transient interface state, and controls designed for hands and eyes.

When humans are forced into a chat-only workflow, they must describe relationships that would be easier to express by pointing: "the image on the right," "the second box," or "move this slightly closer to that heading."

Both approaches provide one native interface and one translated experience. One participant works naturally; the other must adapt.

### The Shared-Medium Shift  

Slidra does not ask humans and agents to share an interface. It gives them separate native interfaces over a shared medium.

For humans, that interface is a visual editor. For agents, it is a structured command surface. Underneath both is the same `.slidra` presentation, with the same object identities, document capabilities, and validation rules.

The GUI routes its supported edits through the same command layer that agents use. This does not mean every CLI command has a matching GUI control. It means that supported human and agent operations converge on the same underlying state rather than producing parallel versions of the presentation.

### UX-Friendly Means Preserving Direct Manipulation  

Humans should be able to select objects, drag them, resize them, arrange layers, align groups, edit text in place, and adjust animation timing while seeing the visual result immediately.

These are not legacy interactions that AI should replace. They are high-bandwidth forms of visual communication. In many situations, a two-second drag expresses intent more precisely than a paragraph of instructions.

### AX-Friendly Means Exposing Structured Operations  

Agents need a different kind of precision. They should be able to retrieve stable object IDs, inspect document state, target a specific element, compose operations, receive structured errors, and continue working from those errors.

An AX-friendly interface does not imitate a mouse. It exposes the semantics behind the action: move this object, group these elements, set this effect, or validate this deck.

Humans and agents are therefore both first-class users, but they are not the same kind of user.

### Context Should Flow Between Interfaces  

The strongest collaboration happens when context can move between these interfaces without being flattened into prose. A visual selection can provide an object reference. The user's words provide intent. The `.slidra` document provides surrounding state. The CLI provides execution, and the validator provides feedback.

Today, Slidra supports an initial form of this flow through comments pinned to a selected object or page. Those comments can carry the slide path and target ID into the agent's next prompt. Broader automatic selection-context transfer remains an area for further development.

The principle is simple: **the interface should not force people to describe what they can simply point at.**

### One Presentation, One Continuous Process  

Once humans and agents operate on the same document through their respective interfaces, generation and editing no longer need to be separate modes.

An agent can create the first draft. A person can move an object and pin a comment to it. The agent can revise that object through a targeted command. The person can review the result visually. Validation can expose concrete problems, and either participant can make the next correction.

The process can alternate as often as necessary without exporting, regenerating, or reconciling separate copies. The document remains continuous even as control moves between participants.

---

## A Reliable Way of Working  

Slidra is not an argument against slide generation. It is an attempt to make generation part of a larger, more dependable process.

Its governed harness gives agents explicit representation, bounded actions, operational discipline, and executable feedback. Its shared medium allows humans to retain direct visual control while agents work through structured operations.

Slidra gives agents a world structured enough for reliable work and gives humans a medium flexible enough for natural collaboration.

**The future of AI slides is not a better handoff between generation and editing. It is a shared way of working in which the handoff disappears.**

---

## The Product Experience Slidra Enables  

From a user's perspective, Slidra feels less like switching between an AI generator and a traditional editor, and more like working with an agent inside the presentation itself.

### 1. Start with AI, Then Keep Editing  

Users can ask an agent to create an initial deck and then continue refining the same presentation. They do not need to export the result into another tool merely to begin serious editing.

### 2. Direct Manipulation Remains Available  

Users can select, drag, resize, rotate, group, align, reorder, and edit objects visually. AI assistance does not require giving up the immediacy of working directly on the canvas.

### 3. Point First, Explain Less  

Users can attach a comment to a selected object or page and let that reference flow into the agent's next task. Instead of describing "the box below the chart," they can identify the object visually and explain only what should change.

### 4. See Human and Agent Edits in the Same Place  

Supported GUI edits and agent commands operate through the same command layer and update the same `.slidra` document. The canvas reflects the agent's changes, while subsequent agent work begins from the state created by the user.

### 5. Receive Concrete Feedback Instead of a Vague "Done"  

Validation can report the affected slide, object, rule, actual value, and expected limit. This makes problems easier to locate and gives the agent or user a concrete basis for the next correction.

### 6. Move Fluidly Between Manual and Agentic Work  

A user might ask the agent to draft a slide, manually adjust its composition, pin a revision request to one object, let the agent update it, and then review the result visually. The workflow can alternate repeatedly without creating separate human and AI versions.

**The resulting experience is not "generate, export, and repair." It is "create, inspect, adjust, validate, and continue"—with humans and agents participating in the same evolving presentation.**