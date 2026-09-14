# Shape language: sketch-notes

**One line**: Hand-drawn doodle lines, slightly crooked frames, casual arrows. Like a visual note-taker drawing live.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

Frames are **hand-drawn rectangles** (corners don't quite meet, edges slightly curved). Arrows are a freehand curve with a triangle. Small doodles (stars, exclamation marks, speech bubbles) can serve as `garnish`.

## Type character

Rounded or handwriting-style face. Headings can have a doodled underline (a wavy line drawn back and forth twice).

## Whitespace rhythm

Not strictly aligned — deliberately offset elements by ±4px. But **the text baselines must still align**, or it becomes cluttered rather than hand-drawn.

## Material and depth

Paper base color with dark lines. Completely flat.

**Suited for**: Workshops, course notes, brainstorming, internal drafts.
**Not suited for**: Formal external presentations, content requiring precision.

## How to achieve it

Replace rectangles with four separate `<path>` segments, each slightly curved; add a ±4 random offset to element positions; arrows use quadratic Béziers.
