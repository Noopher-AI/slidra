/**
 * The family every CoMotion build ships — the one
 * `buildMinimalPresentation` embeds into a new presentation.
 *
 * It doubles as the family a `<text>` is measured against when it declares
 * no `font-family` of its own (legal SVG: the attribute is optional).
 * ADR-0016's rule that a presentation must not depend on "a font that
 * happens to be installed" still holds — these bytes travel with the
 * program, not with the user's machine, so the measurement stays
 * environment-independent, which is the property that ADR actually
 * protects.
 *
 * Deliberately just the name: this module is reachable from the browser
 * bundle (element-text.ts imports it), so the bytes themselves live in
 * default-font-bytes.ts, which reads them off disk with node:fs.
 */
export const DEFAULT_FONT_FAMILY = "Noto Sans TC";
