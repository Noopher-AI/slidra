import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { alignElements, distributeElements } from "../src/element-arrange.js";
import { parseFont, type FontMetrics } from "../src/text-metrics.js";

/**
 * `element align` / `element distribute` against `<text>` targets
 * (NOOP-90/T2 §3.4): `resolveTargets` now passes a `fontBook` through to
 * `elementBounds`, so a `<text>`/text-box target no longer makes the whole
 * command fail. Without `fonts` this still throws exactly as it always did
 * (`geometry-text-bounds.test.ts` already covers that at the `elementBounds`
 * layer) — this file covers the two commands that call it.
 */

const SLIDE_PATH = "slides/001.svg";
const FAMILY = "Noto Sans TC";

const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);

function slide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${inner}</svg>`;
}

describe("alignElements / distributeElements with a <text> target", () => {
  let fonts: ReadonlyMap<string, FontMetrics>;

  beforeAll(async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
  });

  it("without fonts, a <text> target still throws exactly as before (no behaviour change for existing callers)", () => {
    const svg = slide(
      '<g id="el-a"><rect x="0" y="0" width="10" height="10"/></g>' +
        `<g id="el-t"><text font-family="${FAMILY}" font-size="20" x="0" y="18">A</text></g>`,
    );
    expect(() => alignElements(svg, SLIDE_PATH, ["el-a", "el-t"], "left", new Map())).toThrow(CoMotionError);
  });

  it("align left: a <text> target's measured bbox.x is used, not a thrown error", () => {
    const svg = slide(
      '<g id="el-a" transform="translate(50 0)"><rect x="0" y="0" width="10" height="10"/></g>' +
        `<g id="el-t" transform="translate(0 0)"><text font-family="${FAMILY}" font-size="20" x="0" y="18">A</text></g>`,
    );

    const result = alignElements(svg, SLIDE_PATH, ["el-a", "el-t"], "left", fonts);

    // el-t's <text x="0"> already sits at the leftmost bbox.x (0), so aligning
    // left moves el-a's translate to match it exactly — `formatTransform`
    // omits an all-zero translate, so the container has no transform at all.
    expect(result).toContain('<g id="el-a"><rect');
  });

  it("distribute horizontal: three targets including a <text> box are spaced by measured bbox centers", () => {
    const svg = slide(
      '<g id="el-a" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>' +
        '<g id="el-box" data-comot-text-width="20" transform="translate(100 0)">' +
        `<text font-family="${FAMILY}" font-size="20" xml:space="preserve"><tspan x="0" y="18">A</tspan></text></g>` +
        '<g id="el-c" transform="translate(300 0)"><rect x="0" y="0" width="10" height="10"/></g>',
    );

    // Should not throw — the previous behaviour (no fontBook) failed the whole command.
    const result = distributeElements(svg, SLIDE_PATH, ["el-a", "el-box", "el-c"], "horizontal", fonts);

    expect(result).not.toBe(svg);
    // el-a and el-c are the first/last by center and stay fixed.
    expect(result).toContain('id="el-a" transform="translate(0 0)"');
    expect(result).toContain('id="el-c" transform="translate(300 0)"');
  });

  it("a genuinely unmeasurable target (path with an elliptical arc) still fails the whole command, even with fonts supplied", () => {
    const svg = slide(
      '<g id="el-a"><rect x="0" y="0" width="10" height="10"/></g>' +
        '<g id="el-arc"><path d="M10 10 A5 5 0 0 1 20 20"/></g>',
    );
    const before = svg;
    expect(() => alignElements(svg, SLIDE_PATH, ["el-a", "el-arc"], "left", fonts)).toThrow(CoMotionError);
    // Atomicity: a thrown alignElements never mutates the input string (pure function), so re-reading it back is unchanged.
    expect(svg).toBe(before);
  });
});
