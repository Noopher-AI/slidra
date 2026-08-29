/**
 * Formats an SVG numeric attribute with the project's four-decimal
 * serialization precision. Keeping it outside `geometry/` lets text-box
 * writers share the rule without extending that module's public surface.
 */
export function formatSvgNumber(value: number): string {
  const rounded = Number(value.toFixed(4));
  // `-0` and `0` are the same SVG value; serialize only one representation.
  return String(rounded === 0 ? 0 : rounded);
}
