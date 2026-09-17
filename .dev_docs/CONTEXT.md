# Slidra

An SVG-native presentation editor. Humans and agents edit the same deck together — the
agent through the CLI, the human through the visual editor.

## How to read this glossary

A word earns a place here only if getting it wrong causes a concrete mistake. Ordinary
words that happen to appear in the product are not terms. Every *Avoid* entry carries the
reason it is dangerous; an avoid-list without reasons is broken by the first person under
deadline pressure.

## Language

### Deck content

**Deck**
A complete Slidra work: ordered slides, assets and settings, in one file.
*Avoid*: **project** — it suggests a folder of loose files, and the single-file promise is
the thing the storage model was built to keep.

**Slide**
One page of a deck, expressed as one SVG.
*Avoid*: **page** — it invites reflowable-document thinking; a slide is a fixed canvas.

**Element**
A visual object inside a slide that can be addressed and manipulated on its own.
*Avoid*: **layer** — layers imply a global stack the format does not have; nesting is by
containment, not by z-order bookkeeping.

**Canvas**
The deck's page dimensions. A deck has exactly one, and every slide is designed against it.
*Avoid*: **page size** — it implies a print setting that can differ per slide. It cannot.

**Asset**
An external media file a slide refers to — video, audio, a raster image.
*Avoid*: **attachment** — attachments ride along; assets are inside the deck and playback
depends on them being there.

**Group**
Several elements treated as one. A group is itself an element and can be grouped again.
*Avoid*: **collection** — it suggests a loose set; a group moves as one object.

**Text box**
An element holding text. It has a width, and text wraps on its own once it fills the box.
A single line of text is not an element.
*Avoid*: **label** — labels are atomic strings; a text box owns wrapping and its own width.

**Template**
A starting slide that can be applied. Applying it copies the whole thing onto a new slide;
from that instant the two are unrelated. **A template dies the moment it is used.**
*Avoid*: **master** — it implies that changing the master changes every slide made from it.
It does not. Rejecting that inheritance is a deliberate decision (ADR-0009), not an omission.

**Lock**
A marker saying an element is structural scaffolding and should not be moved casually.
It guards against slips, not against intent.
*Avoid*: **read-only** — it suggests an absolute prohibition; a lock can be overridden on
purpose, and that is the point.

**Speaker notes**
Text attached to a slide, visible only to the presenter, never on the slide itself.
*Avoid*: **comment** — comments are addressed to other people and can be resolved; speaker
notes are part of the delivery.

### Motion

**Step**
The unit of advancement during playback. Advancing fires every effect belonging to that
step. Steps are derived from the effect list, never stored, and never span slides.
*Avoid*: **frame** — frames are time-driven; a step waits for a person.

**Effect**
One change applied to exactly one element. Effects belong to families; media playback is
itself an effect, not a separate mechanism.
*Avoid*: **animation** — it implies a timeline; effects are triggered, not scheduled.

**Effect list**
The explicit ordering of a slide's effects, written into that slide's SVG.
*Avoid*: **timeline** — a timeline has a clock. This is a sequence with triggers.

**Transition**
The change when moving between slides, split into an entering and a leaving half. Each
slide decides its own; it is not shared across the deck.
*Avoid*: **crossfade** — naming one effect as the category hides that the choice is per slide.

### Human–agent collaboration

**Command**
A semantic operation exposed by the CLI. Commands are the only way to modify a deck —
humans and agents both go through them.
*Avoid*: **API** — an API is a surface you can extend locally; the command set is the
product specification, and adding one is a product decision (ADR-0002).

**Annotation**
A one-line edit instruction a person attaches to an element for the agent to act on. It is
bundled with the message the person sends.
*Avoid*: **comment** — comments are for other humans and persist; an annotation is consumed.

**Editing charter**
The first message sent to an agent in a conversation, explaining the operating rules and the
available commands. It is an ordinary user message.
*Avoid*: **system prompt** — implementing it as one makes behaviour diverge between agent
vendors, which is exactly what sending it as a user message avoids.
