import { escapeXmlText } from "../element-text.js";
import { formatSvgNumber } from "../geometry/transform.js";
import type { WrappedLine } from "./wrap.js";

/**
 * Serializes wrapped lines into the inner markup of a text box's `<text>`
 * element: one `<tspan x="0" y="…">…</tspan>` per line.
 *
 * No whitespace whatsoever between `<text>` and the first `<tspan>`, and
 * none between tspans. The `<text>` this is spliced into carries
 * `xml:space="preserve"` (so the exact source text a browser lays out
 * agrees with what `FontBook.measureText` measured), and under that
 * attribute any indentation between tspans is rendered content, not
 * formatting — pretty-printing here would visibly corrupt every text box.
 *
 * No Node built-in import, not even transitively (#76): this module
 * reuses `escapeXmlText` from `../element-text.js`, which this unit made
 * Node-free for exactly this reason (see that module's header comment).
 */
export function renderTextBoxContent(lines: readonly WrappedLine[]): string {
  return lines
    .map((line) => `<tspan x="0" y="${formatSvgNumber(line.y)}">${escapeXmlText(line.text)}</tspan>`)
    .join("");
}
