import { describe, expect, it } from "vitest";
import { checkSlideCompliance, parseSlide } from "../src/slide/format.js";
import { buildShapeMarkup, removeElements } from "../src/slide/edit.js";

/**
 * Pure unit tests for `packages/core/src/slide/edit.ts` (#74): the markup
 * builder behind `rect add`/`ellipse add`/`line add`/`path add`, and the
 * byte-offset splice removal behind `element delete`. The CLI seam tests
 * (`packages/cli/test/shape.test.ts`, `element-delete.test.ts`) exercise the
 * same logic end to end through the real command registry; these tests
 * pin the pure function's own contract directly.
 */

const wrap = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n${body}\n</svg>\n`;

describe("buildShapeMarkup", () => {
  it("builds a compliant rect container: id and position on the <g>, no transform on the primitive", () => {
    const markup = buildShapeMarkup("el-rect1", { kind: "rect", x: 10, y: 20, width: 100, height: 50, fill: "#f00" });
    expect(markup).toBe('<g id="el-rect1" transform="translate(10 20)"><rect width="100" height="50" fill="#f00"/></g>');
  });

  it("omits the fill attribute entirely when --fill is absent, rather than inventing a colour", () => {
    const markup = buildShapeMarkup("el-rect2", { kind: "rect", x: 0, y: 0, width: 10, height: 10 });
    expect(markup).toBe('<g id="el-rect2" transform="translate(0 0)"><rect width="10" height="10"/></g>');
  });

  it("builds a compliant ellipse container with rx/ry on the primitive", () => {
    const markup = buildShapeMarkup("el-ell1", { kind: "ellipse", x: 5, y: 6, rx: 30, ry: 15, fill: "blue" });
    expect(markup).toBe('<g id="el-ell1" transform="translate(5 6)"><ellipse rx="30" ry="15" fill="blue"/></g>');
  });

  it("builds a line with the container transform at (x1, y1) and the endpoint written relative to it", () => {
    const markup = buildShapeMarkup("el-line1", { kind: "line", x1: 100, y1: 200, x2: 150, y2: 260, stroke: "#000" });
    expect(markup).toBe(
      '<g id="el-line1" transform="translate(100 200)"><line x1="0" y1="0" x2="50" y2="60" stroke="#000"/></g>',
    );
  });

  it("line add rejects an empty --stroke (SVG has no default stroke colour)", () => {
    expect(() =>
      buildShapeMarkup("el-line2", { kind: "line", x1: 0, y1: 0, x2: 1, y2: 1, stroke: "" }),
    ).toThrow("--stroke");
  });

  it("line add writes --stroke-width when given, but never invents one when absent", () => {
    const withWidth = buildShapeMarkup("el-line3", { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0, stroke: "red", strokeWidth: 3 });
    expect(withWidth).toContain('stroke-width="3"');
    const withoutWidth = buildShapeMarkup("el-line4", { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0, stroke: "red" });
    expect(withoutWidth).not.toContain("stroke-width");
  });

  it("builds a path with --d written verbatim, never parsed, even when it is not valid path syntax", () => {
    const markup = buildShapeMarkup("el-path1", { kind: "path", x: 0, y: 0, d: "not a real path command" });
    expect(markup).toBe('<g id="el-path1" transform="translate(0 0)"><path d="not a real path command"/></g>');
  });

  it("path add rejects an empty --d", () => {
    expect(() => buildShapeMarkup("el-path2", { kind: "path", x: 0, y: 0, d: "" })).toThrow();
  });

  it("rejects a width that is positive but rounds to 0 at 4 decimals, before any markup is returned", () => {
    expect(() =>
      buildShapeMarkup("el-rect3", { kind: "rect", x: 0, y: 0, width: 0.00004, height: 10 }),
    ).toThrow("四捨五入後不是大於 0");
  });

  it("rejects a non-finite coordinate", () => {
    expect(() =>
      buildShapeMarkup("el-rect4", { kind: "rect", x: Infinity, y: 0, width: 10, height: 10 }),
    ).toThrow();
  });

  // W2-R13 regression: x1/y1/x2/y2 individually pass Number.isFinite, but
  // opposite maximum-finite endpoints make x2 - x1 overflow to Infinity —
  // a value the SVG number grammar cannot express and nothing downstream
  // rejects.
  it("rejects a line whose endpoints are each finite but whose derived dx/dy overflows to Infinity", () => {
    expect(() =>
      buildShapeMarkup("el-line5", {
        kind: "line",
        x1: -Number.MAX_VALUE,
        y1: 0,
        x2: Number.MAX_VALUE,
        y2: 0,
        stroke: "black",
      }),
    ).toThrow("有限數字");
  });

  it("the inserted markup, spliced into a viewBox'd svg, is compliant and parses to the requested kind", () => {
    const markup = buildShapeMarkup("el-rect5", { kind: "rect", x: 0, y: 0, width: 10, height: 10 });
    const svg = wrap(`  <g id="el-existing"><rect x="0" y="0" width="1" height="1"/></g>\n  ${markup}`);
    expect(checkSlideCompliance(svg)).toEqual([]);
    expect(parseSlide(svg).elements.at(-1)!.kind).toBe("rect");
  });
});

describe("removeElements", () => {
  it("removes one element and reports its id", () => {
    const svg = wrap('  <g id="el-a"><rect width="1" height="1"/></g>\n  <g id="el-b"><rect width="1" height="1"/></g>');
    const result = removeElements(svg, ["el-a"]);
    expect(result.removedIds).toEqual(["el-a"]);
    expect(result.updated).not.toContain("el-a");
    expect(result.updated).toContain("el-b");
  });

  it("throws naming an unknown id and computes no update at all", () => {
    const svg = wrap('  <g id="el-a"><rect width="1" height="1"/></g>');
    expect(() => removeElements(svg, ["el-missing"])).toThrow("el-missing");
  });

  it("throws before any splice when one of several ids is unknown, so nothing is removed", () => {
    const svg = wrap(
      '  <g id="el-a"><rect width="1" height="1"/></g>\n  <g id="el-b"><rect width="1" height="1"/></g>',
    );
    expect(() => removeElements(svg, ["el-a", "el-missing"])).toThrow();
  });

  it("the same id listed twice collapses to one removal, no error", () => {
    const svg = wrap('  <g id="el-a"><rect width="1" height="1"/></g>');
    const result = removeElements(svg, ["el-a", "el-a"]);
    expect(result.removedIds).toEqual(["el-a"]);
  });

  it("a group and one of its own children both listed: both accepted, removed once", () => {
    const svg = wrap(
      '  <g id="el-group"><g id="el-child1"><rect width="1" height="1"/></g><g id="el-child2"><rect width="1" height="1"/></g></g>',
    );
    const result = removeElements(svg, ["el-group", "el-child1"]);
    expect(result.removedIds.sort()).toEqual(["el-child1", "el-child2", "el-group"]);
    expect(result.updated).not.toContain("el-group");
    expect(result.updated).not.toContain("el-child1");
    expect(result.updated).not.toContain("el-child2");
  });

  it("deleting every child of a nested group throws naming the parent, and writes nothing", () => {
    const svg = wrap(
      '  <g id="el-group"><g id="el-only-child"><rect width="1" height="1"/></g></g>',
    );
    expect(() => removeElements(svg, ["el-only-child"])).toThrow("el-group");
  });

  it("deleting a top-level group down to nothing is not an empty-container error (its parent is <svg>, not <g>)", () => {
    const svg = wrap('  <g id="el-only"><rect width="1" height="1"/></g>');
    const result = removeElements(svg, ["el-only"]);
    expect(result.removedIds).toEqual(["el-only"]);
    expect(result.updated).not.toContain("el-only");
  });

  it("refuses a bare, unconverted primitive with a run-convert-first error", () => {
    const svg = wrap('  <rect id="el-bare" width="1" height="1"/>');
    expect(() => removeElements(svg, ["el-bare"])).toThrow("convert");
  });
});

describe("removeElements — clearing effect entries (ADR-0009)", () => {
  // Shape copied from demo/slides/003.svg (read, not edited) — three
  // on-click enter effects targeting three separate elements.
  const effectsSlide = wrap(
    '  <metadata>\n' +
      '    <comot:effects xmlns:comot="https://co-motion.dev/ns">\n' +
      '      <comot:effect target="el-step-one" family="enter" effect="appear" start="on-click"/>\n' +
      '      <comot:effect target="el-step-two" family="enter" effect="fade" start="on-click"/>\n' +
      '      <comot:effect target="el-step-three" family="enter" effect="fade" start="on-click"/>\n' +
      '    </comot:effects>\n' +
      '  </metadata>\n' +
      '  <g id="el-step-one"><rect width="1" height="1"/></g>\n' +
      '  <g id="el-step-two"><rect width="1" height="1"/></g>\n' +
      '  <g id="el-step-three"><rect width="1" height="1"/></g>',
  );

  it("clears exactly the effect entries targeting deleted elements, leaving the others intact", () => {
    const result = removeElements(effectsSlide, ["el-step-one", "el-step-two"]);
    expect(result.removedEffects).toBe(2);
    const remaining = result.updated.match(/<comot:effect\b/g) ?? [];
    expect(remaining).toHaveLength(1);
    expect(result.updated).toContain('target="el-step-three"');
    expect(result.updated).not.toContain('target="el-step-one"');
    expect(result.updated).not.toContain('target="el-step-two"');
  });

  it("clears effect entries targeting a descendant of a deleted group, not just the group's own id", () => {
    const svg = wrap(
      '  <metadata>\n' +
        '    <comot:effects xmlns:comot="https://co-motion.dev/ns">\n' +
        '      <comot:effect target="el-inner" family="enter" effect="appear" start="on-click"/>\n' +
        '    </comot:effects>\n' +
        '  </metadata>\n' +
        '  <g id="el-outer"><g id="el-inner"><rect width="1" height="1"/></g></g>',
    );
    const result = removeElements(svg, ["el-outer"]);
    expect(result.removedEffects).toBe(1);
    expect(result.updated).not.toContain("<comot:effect ");
    expect(result.updated).toContain("<comot:effects");
  });

  it("a slide with no <metadata>/effect list reports removedEffects: 0, no error", () => {
    const svg = wrap('  <g id="el-a"><rect width="1" height="1"/></g>');
    const result = removeElements(svg, ["el-a"]);
    expect(result.removedEffects).toBe(0);
  });

  // W2-R12 regression: `effects.ts` (the web player's own reader of this
  // list) finds `<comot:effect>` via a DESCENDANT search, so an entry
  // nested one level under a wrapper element is a real entry to the player
  // even though it is not a direct child of `<comot:effects>`. Before this
  // fix, `removeElements` only looked at direct children and left such an
  // entry on disk after its target was deleted — a dangling reference
  // ADR-0009 says must never be written.
  it("clears an effect entry nested inside a wrapper element under <comot:effects>, not just direct children", () => {
    const svg = wrap(
      '  <metadata>\n' +
        '    <comot:effects xmlns:comot="https://co-motion.dev/ns">\n' +
        '      <comot:effect target="el-flat" family="enter" effect="fade" start="on-click"/>\n' +
        '      <comot:group>\n' +
        '        <comot:effect target="el-nested" family="enter" effect="fade" start="on-click"/>\n' +
        '      </comot:group>\n' +
        '    </comot:effects>\n' +
        '  </metadata>\n' +
        '  <g id="el-flat"><rect width="1" height="1"/></g>\n' +
        '  <g id="el-nested"><rect width="1" height="1"/></g>',
    );
    const result = removeElements(svg, ["el-nested"]);
    expect(result.removedEffects).toBe(1);
    expect(result.updated).not.toContain('target="el-nested"');
    expect(result.updated).toContain('target="el-flat"');
  });

  // W2-R14 regression: `effects.ts` matches by namespace URI
  // (getElementsByTagNameNS), which a default `xmlns="…"` binding satisfies
  // just as well as a prefixed `xmlns:comot="…"` one. Before this fix,
  // `removeElements` only tracked `xmlns:PREFIX` bindings and required a
  // non-null prefix on the tag, so a default-namespace effect list was
  // invisible to it — leaving a dangling target reference on disk.
  it("clears an effect entry written with a default (unprefixed) namespace", () => {
    const svg = wrap(
      '  <metadata>\n' +
        '    <effects xmlns="https://co-motion.dev/ns">\n' +
        '      <effect target="el-flat" family="enter" effect="fade" start="on-click"/>\n' +
        '      <effect target="el-delete" family="enter" effect="fade" start="on-click"/>\n' +
        '    </effects>\n' +
        '  </metadata>\n' +
        '  <g id="el-flat"><rect width="1" height="1"/></g>\n' +
        '  <g id="el-delete"><rect width="1" height="1"/></g>',
    );
    const result = removeElements(svg, ["el-delete"]);
    expect(result.removedEffects).toBe(1);
    expect(result.updated).not.toContain('target="el-delete"');
    expect(result.updated).toContain('target="el-flat"');
  });

  // Same default-namespace binding as above, combined with W2-R12's
  // descendant-wrapper case in one list.
  it("clears a default-namespace effect entry nested inside a wrapper element", () => {
    const svg = wrap(
      '  <metadata>\n' +
        '    <effects xmlns="https://co-motion.dev/ns">\n' +
        '      <effect target="el-flat" family="enter" effect="fade" start="on-click"/>\n' +
        '      <group>\n' +
        '        <effect target="el-nested" family="enter" effect="fade" start="on-click"/>\n' +
        '      </group>\n' +
        '    </effects>\n' +
        '  </metadata>\n' +
        '  <g id="el-flat"><rect width="1" height="1"/></g>\n' +
        '  <g id="el-nested"><rect width="1" height="1"/></g>',
    );
    const result = removeElements(svg, ["el-nested"]);
    expect(result.removedEffects).toBe(1);
    expect(result.updated).not.toContain('target="el-nested"');
    expect(result.updated).toContain('target="el-flat"');
  });

  // Negative case: an unprefixed <effects> with no xmlns of its own resolves
  // to the inherited SVG namespace (from <svg xmlns="…">), not the effects
  // namespace, so it must NOT be treated as an effect list. A fix that
  // matches any unprefixed "effects" tag regardless of resolved namespace
  // breaks exactly this.
  it("does not treat an unprefixed <effects> with no xmlns of its own as an effect list", () => {
    const svg = wrap(
      '  <metadata>\n' +
        '    <effects>\n' +
        '      <effect target="el-delete" family="enter" effect="fade" start="on-click"/>\n' +
        '    </effects>\n' +
        '  </metadata>\n' +
        '  <g id="el-delete"><rect width="1" height="1"/></g>',
    );
    const result = removeElements(svg, ["el-delete"]);
    expect(result.removedEffects).toBe(0);
    expect(result.updated).toContain('target="el-delete"');
  });
});
