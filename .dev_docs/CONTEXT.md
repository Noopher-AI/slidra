# Slidra

An SVG-native presentation editor. Humans and agents edit the same deck together — the agent operates
through the CLI, the human through the visual editor.

## Language

### Deck content

**Deck**:
A complete Slidra work, made up of ordered slides, assets, and settings.
_Avoid_: project, PPT, file

**Slide**:
A single page within a deck, expressed as one SVG.
_Avoid_: page

**Element**:
A visual object inside a slide that can be independently addressed and manipulated.
_Avoid_: object, layer, shape, node

**Display name**:
The human-facing name of an element. Distinct from the identifier used to address the element —
changing it does not affect addressing.
_Avoid_: label, alias

**Canvas**:
The deck's page dimensions. A deck has exactly one, and every slide is designed against it.
_Avoid_: layout, page size, canvas size setting

**Selection**:
The element the user is currently pointing at. It exists only for the duration of that interaction —
it is never written into the deck and never changes any content.
_Avoid_: selected, focused, focus, active

**Asset**:
An external media file referenced by a slide — a video, audio, or raster image, for example.
_Avoid_: material, media, resource, attachment

**Group**:
Several elements treated as a single element. A group is itself an element, and can be grouped again.
_Avoid_: composite, collection, layer group

**Text box**:
An element that holds text. It has a width, and text wraps to the next line on its own once it fills
the box. A single line of text is not itself an element.
_Avoid_: text block, label, string

**Dynamic text**:
Content that isn't typed in but computed by Slidra from the current context — a page number, for
example.
_Avoid_: field, variable, placeholder

**Template**:
A starting slide that can be applied. Applying it copies the whole thing onto a new slide; from that
point on, the two are unrelated. A deck can have several templates.
_Avoid_: master, layout, master slide, master layout, theme

**Lock**:
A marker on an element indicating it is structural scaffolding for the layout and shouldn't be touched
casually. The human can't reach it in the editor. It guards against accidental slips, not an absolute
prohibition.
_Avoid_: read-only, immutable, frozen, protected

**Speaker notes**:
Text visible only to the presenter, attached to a slide, that never appears on the slide itself.
_Avoid_: comment, script, notes, narration

### Motion

**Step**:
The unit of advancement during playback. Each time the user advances, all effects belonging to that
step happen together. Steps aren't stored directly — they're derived from the effect list: a group of
effects starting with a "click" trigger forms one step. Scope is confined to a single slide.
_Avoid_: animation frame, frame, time point, timeline

**Effect**:
A single change applied to an element. Effects fall into families — entrance, emphasis, exit, and so
on; for audio/video assets, playback itself is an effect. Every effect targets exactly one element, no
exceptions.
_Avoid_: animation, special effect, build

**Effect list**:
The explicit ordering of all effects on a slide, written into that slide's SVG. A slide is
self-contained — swapping two slides requires touching no other file.
_Avoid_: timeline, animation pane, sequence

**Entrance**:
An effect family: making a static element appear. Media playback is not part of this family — it's an
effect in a different family.
_Avoid_: animation, special effect, transition, effect

**Transition**:
The change that happens when moving from one slide to the next, split into an "Enter" half and an
"Exit" half; each slide decides its own effect and duration for each half — it is not shared uniformly
across the whole deck.
_Avoid_: page-change effect, switch, crossfade

**Play**:
The mode of presenting a deck by advancing through steps, as opposed to editing. Whether it's fullscreen
is up to the user — that's not part of the definition of playback.
_Avoid_: presentation, screening, preview, presentation mode

**Overview**:
A view that lays out every slide in the deck, shrunk down and in order, for at-a-glance navigation and
jumping between slides.
_Avoid_: filmstrip, outline, sidebar

### Human-agent collaboration

**Command**:
A semantic operation exposed by the CLI. Commands are the only way to modify a deck — both humans and
agents go through them.
_Avoid_: API, instruction, action, operation

**Annotation**:
A one-line edit instruction the user attaches to an element for the agent to act on. It's bundled along
when the user sends their message to the agent.
_Avoid_: comment, remark, tag

**Editing charter**:
The first message sent to the agent at the start of a conversation, explaining Slidra's operating
rules and available commands.
_Avoid_: system prompt, skill, instructions
