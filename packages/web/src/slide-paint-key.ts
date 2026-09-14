// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * #303: what the stage actually *paints* of a slide — its markup with every
 * `<metadata>…</metadata>` block removed and trailing whitespace dropped.
 *
 * Live reload fires on every agent command, and most of what a build issues
 * (`effect add`, `slide notes set`, `comment *`, `slide transition set`)
 * changes only `<metadata>`: the visible SVG is byte-identical, so
 * reassigning the stage iframe's `srcdoc` would blank and repaint an
 * unchanged picture — the flicker authors saw during generation. Two
 * slides with equal paint keys look the same on the stage; `canvas.ts`
 * skips the repaint when the key of the slide it last painted matches.
 *
 * Only `<metadata>` is stripped — it is the one part of a slide the stage
 * never draws (ADR-0003/0008: notes, comments, effects, transition all live
 * there). Anything else that differs is a real visual change.
 */
export function slidePaintKey(svgMarkup: string): string {
  return svgMarkup.replace(/<metadata(?:\s[^>]*)?>[\s\S]*?<\/metadata>/g, "").trimEnd();
}
